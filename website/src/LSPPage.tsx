import { useState } from 'react';
import {
    useCurrentAccount,
    useIotaClientQuery,
    useSignAndExecuteTransaction,
    useIotaClient,
} from '@iota/dapp-kit';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Transaction } from '@iota/iota-sdk/transactions';
import { IOTA_SYSTEM_STATE_OBJECT_ID } from '@iota/iota-sdk/utils';
import { LSP_PACKAGE_ID, LSP_POOL_ID, LSP_POOL_INITIAL_SHARED_VERSION, RIOTA_COIN_TYPE } from './constants';
import {
    createLspDepositTransaction,
    createLspWithdrawTransaction,
    createLspSwapTransaction,
    createAddValidatorTransaction,
} from './lib/transactions';
import { formatIota, waitAndCheckTx } from './lib/utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFields = any;

interface PoolData {
    validators: string[];
    riotaSupply: bigint;
    userAllowlist: string[];
    vaultsTableId: string;
}

function usePoolData() {
    const client = useIotaClient();
    return useQuery({
        queryKey: ['lsp-pool-data', LSP_POOL_ID],
        queryFn: async (): Promise<PoolData> => {
            const obj = await client.getObject({
                id: LSP_POOL_ID,
                options: { showContent: true },
            });
            const fields = (obj.data?.content as AnyFields)?.fields;
            if (!fields) throw new Error('Failed to read pool object');

            const validators: string[] = fields.validators ?? [];
            const supply = BigInt(
                fields.treasury_cap?.fields?.total_supply?.fields?.value ?? '0',
            );
            const userAllowlist: string[] = fields.user_allowlist ?? [];
            const vaultsTableId: string = fields.vaults?.fields?.id?.id ?? '';

            return { validators, riotaSupply: supply, userAllowlist, vaultsTableId };
        },
        staleTime: 30_000,
    });
}

function usePoolValue(poolData: PoolData | undefined) {
    const client = useIotaClient();
    return useQuery({
        queryKey: ['lsp-pool-value', poolData?.validators, poolData?.vaultsTableId],
        queryFn: async (): Promise<bigint> => {
            if (!poolData || poolData.validators.length === 0) return 0n;

            const results = await Promise.all(
                poolData.validators.map(async (v) => {
                    const [vaultRes, rateRes] = await Promise.all([
                        client.getDynamicFieldObject({
                            parentObjectId: poolData.vaultsTableId,
                            name: { type: 'address', value: v },
                            options: { showContent: true },
                        }),
                        client.getDynamicFieldObject({
                            parentObjectId: LSP_POOL_ID,
                            name: {
                                type: `${LSP_PACKAGE_ID}::pool::CachedRateKey`,
                                value: { validator: v },
                            },
                            options: { showContent: true },
                        }),
                    ]);

                    const vaultFields = (vaultRes.data?.content as AnyFields)?.fields?.value
                        ?.fields;
                    if (!vaultFields) return 0n;

                    const rateFields = (rateRes.data?.content as AnyFields)?.fields?.value
                        ?.fields;

                    // Candidate validators have no CachedRate (no exchange rate history).
                    // Their rate is 1:1, so total_staked == IOTA value.
                    if (!rateFields) return BigInt(vaultFields.total_staked ?? '0');

                    const totalPoolTokens = BigInt(vaultFields.total_pool_tokens ?? '0');
                    const iotaAmount = BigInt(rateFields.iota_amount ?? '0');
                    const poolTokenAmount = BigInt(rateFields.pool_token_amount ?? '0');

                    if (poolTokenAmount === 0n) return BigInt(vaultFields.total_staked ?? '0');
                    return (totalPoolTokens * iotaAmount) / poolTokenAmount;
                }),
            );

            return results.reduce((sum, v) => sum + v, 0n);
        },
        enabled: !!poolData && poolData.validators.length > 0 && poolData.vaultsTableId !== '',
        staleTime: 30_000,
    });
}

function usePoolApy() {
    const client = useIotaClient();
    return useQuery({
        queryKey: ['lsp-pool-apy'],
        queryFn: async (): Promise<number | null> => {
            const tx = new Transaction();
            tx.moveCall({
                target: `${LSP_PACKAGE_ID}::pool::pool_apy`,
                arguments: [
                    tx.sharedObjectRef({
                        objectId: LSP_POOL_ID,
                        initialSharedVersion: LSP_POOL_INITIAL_SHARED_VERSION,
                        mutable: true,
                    }),
                    tx.sharedObjectRef({
                        objectId: IOTA_SYSTEM_STATE_OBJECT_ID,
                        initialSharedVersion: 1,
                        mutable: true,
                    }),
                ],
            });
            const result = await client.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
            });
            const bytes = result.results?.[0]?.returnValues?.[0]?.[0];
            if (!bytes || bytes.length === 0) return null;
            // u256 BCS: 32 bytes little-endian
            let raw = 0n;
            for (let i = bytes.length - 1; i >= 0; i--) {
                raw = (raw << 8n) | BigInt(bytes[i]);
            }
            // raw is a growth factor over 7 epochs, scaled by YIELD_PRECISION (1e18).
            // 1e18 = 1× (0% yield). Annualize: APY% = (growth - 1) / 7 × 365 × 100
            const YIELD_PRECISION = 1_000_000_000_000_000_000n;
            if (raw <= YIELD_PRECISION) return 0;
            return Number((raw - YIELD_PRECISION) * 36500n) / Number(YIELD_PRECISION * 7n);
        },
        staleTime: 60_000,
    });
}

function useValidatorNames() {
    const { data: systemState } = useIotaClientQuery('getLatestIotaSystemState');
    const nameMap = new Map<string, string>();
    if (systemState?.activeValidators) {
        for (const v of systemState.activeValidators) {
            nameMap.set(v.iotaAddress, v.name);
        }
    }
    return nameMap;
}

function PoolStats({ poolData, poolValue, poolApy }: {
    poolData: PoolData | undefined;
    poolValue: bigint | undefined;
    poolApy: number | null | undefined;
}) {
    if (!poolData) return <div className="card">Loading pool stats...</div>;

    const supply = poolData.riotaSupply;
    const value = poolValue ?? 0n;
    const rate = supply > 0n && value > 0n
        ? (Number(value) / Number(supply)).toFixed(6)
        : supply === 0n ? '1.0000' : '...';

    return (
        <div className="card">
            <h2>Pool Stats</h2>
            <div className="validator-detail">
                <span className="label">rIOTA Supply</span>
                <span className="value">{formatIota(supply.toString(), 2)} rIOTA</span>
            </div>
            <div className="validator-detail">
                <span className="label">Pool Value</span>
                <span className="value">
                    {value > 0n ? `${formatIota(value.toString(), 2)} IOTA` : supply === 0n ? '0 IOTA' : '...'}
                </span>
            </div>
            <div className="validator-detail">
                <span className="label">Exchange Rate</span>
                <span className="value">1 rIOTA = {rate} IOTA</span>
            </div>
            <div className="validator-detail">
                <span className="label">Pool APY</span>
                <span className="value">
                    {poolApy != null ? `${poolApy.toFixed(2)}%` : '...'}
                </span>
            </div>
            <div className="validator-detail">
                <span className="label">Validators</span>
                <span className="value">{poolData.validators.length}</span>
            </div>
        </div>
    );
}

function LSPPage() {
    const account = useCurrentAccount();
    const { data: poolData } = usePoolData();
    const { data: poolValue } = usePoolValue(poolData);
    const { data: poolApy } = usePoolApy();

    const isAllowed = !poolData
        ? null
        : poolData.userAllowlist.length === 0 ||
          (account && poolData.userAllowlist.includes(account.address));

    return (
        <main className="main">
            <PoolStats poolData={poolData} poolValue={poolValue} poolApy={poolApy} />
            {!account ? (
                <div className="card connect-prompt">
                    <p>Connect your wallet to use the Liquid Staking Pool</p>
                </div>
            ) : isAllowed === false ? (
                <div className="card">
                    <p className="hint">
                        The pool is in closed testing. Your address is not in the allowlist.
                    </p>
                </div>
            ) : (
                <>
                    <DepositSection address={account.address} poolData={poolData} />
                    <WithdrawSection address={account.address} />
                </>
            )}
        </main>
    );
}

function DepositSection({ address, poolData }: { address: string; poolData: PoolData | undefined }) {
    const { data: stakes, isPending } = useIotaClientQuery('getStakes', { owner: address });
    const [pendingAction, setPendingAction] = useState<string | null>(null);
    const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
    const [swapAmounts, setSwapAmounts] = useState<Record<string, string>>({});

    const iotaClient = useIotaClient();
    const queryClient = useQueryClient();
    const { mutate: signAndExecute } = useSignAndExecuteTransaction();
    const validatorNames = useValidatorNames();

    const poolValidators = new Set(poolData?.validators ?? []);

    // Collect all active stakes across all validators
    const allStakes = stakes?.flatMap((s) =>
        s.stakes
            .filter((stake) => stake.status === 'Active')
            .map((stake) => ({
                ...stake,
                validatorAddress: s.validatorAddress,
                stakingPool: s.stakingPool,
            })),
    ) ?? [];

    async function handleDeposit(stakedIotaId: string) {
        setStatus(null);
        setPendingAction(stakedIotaId);
        const tx = createLspDepositTransaction(stakedIotaId);
        tx.setSender(address);
        await tx.build({ client: iotaClient });
        signAndExecute(
            { transaction: tx },
            {
                onSuccess: async ({ digest }) => {
                    const txCheck = await waitAndCheckTx(iotaClient, digest);
                    await queryClient.invalidateQueries({
                        predicate: (query) => {
                            const key = query.queryKey;
                            return key[1] === 'getStakes' || key[1] === 'getBalance' || key[1] === 'getCoins'
                                || key[0] === 'lsp-pool-data' || key[0] === 'lsp-pool-value';
                        },
                    });
                    if (txCheck.ok) {
                        setStatus({ type: 'success', msg: 'Deposit successful! You received rIOTA.' });
                    } else {
                        setStatus({ type: 'error', msg: `Transaction failed: ${txCheck.error}` });
                    }
                    setPendingAction(null);
                },
                onError: (err) => {
                    setStatus({ type: 'error', msg: err.message });
                    setPendingAction(null);
                },
            },
        );
    }

    async function handleSwap(stakedIotaId: string, principalNanos: bigint, swapAmountNanos: bigint | null) {
        setStatus(null);
        const actionKey = `swap-${stakedIotaId}`;
        setPendingAction(actionKey);
        // null = full swap, otherwise partial (split first)
        const partial = swapAmountNanos !== null && swapAmountNanos < principalNanos
            ? swapAmountNanos : null;
        const tx = createLspSwapTransaction(stakedIotaId, partial);
        tx.setSender(address);
        await tx.build({ client: iotaClient });
        signAndExecute(
            { transaction: tx },
            {
                onSuccess: async ({ digest }) => {
                    const txCheck = await waitAndCheckTx(iotaClient, digest);
                    await queryClient.invalidateQueries({
                        predicate: (query) => {
                            const key = query.queryKey;
                            return key[1] === 'getStakes' || key[1] === 'getBalance' || key[1] === 'getCoins'
                                || key[0] === 'lsp-pool-data' || key[0] === 'lsp-pool-value';
                        },
                    });
                    if (txCheck.ok) {
                        setStatus({ type: 'success', msg: 'Swap successful! You received a lower-APY StakedIota + rIOTA reward.' });
                    } else {
                        setStatus({ type: 'error', msg: `Transaction failed: ${txCheck.error}` });
                    }
                    setPendingAction(null);
                },
                onError: (err) => {
                    setStatus({ type: 'error', msg: err.message });
                    setPendingAction(null);
                },
            },
        );
    }

    async function handleAddValidator(validatorAddress: string, stakingPoolId: string) {
        setStatus(null);
        const actionKey = `add-${validatorAddress}`;
        setPendingAction(actionKey);
        const tx = createAddValidatorTransaction(validatorAddress, stakingPoolId);
        tx.setSender(address);
        await tx.build({ client: iotaClient });
        signAndExecute(
            { transaction: tx },
            {
                onSuccess: async ({ digest }) => {
                    const txCheck = await waitAndCheckTx(iotaClient, digest);
                    await queryClient.invalidateQueries({
                        predicate: (query) => {
                            const key = query.queryKey;
                            return key[0] === 'lsp-pool-data' || key[0] === 'lsp-pool-value';
                        },
                    });
                    if (txCheck.ok) {
                        setStatus({ type: 'success', msg: `Validator added to pool! You can now deposit stakes from this validator.` });
                    } else {
                        setStatus({ type: 'error', msg: `Transaction failed: ${txCheck.error}` });
                    }
                    setPendingAction(null);
                },
                onError: (err) => {
                    setStatus({ type: 'error', msg: err.message });
                    setPendingAction(null);
                },
            },
        );
    }

    if (isPending) return <div className="card">Loading your stakes...</div>;

    return (
        <div className="card">
            <h2>Deposit StakedIota</h2>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
                Deposit active StakedIota to mint rIOTA. Validators must be added to the pool first.
            </p>
            {allStakes.length === 0 ? (
                <p className="hint">You have no active stakes to deposit.</p>
            ) : (
                <div className="stakes-list">
                    {allStakes.map((stake) => {
                        const isWhitelisted = poolValidators.has(stake.validatorAddress);
                        const name = validatorNames.get(stake.validatorAddress);
                        const addKey = `add-${stake.validatorAddress}`;

                        return (
                            <div key={stake.stakedIotaId} className="stake-item">
                                <div className="stake-info">
                                    <div className="stake-detail">
                                        <span className="label">Principal</span>
                                        <span className="value">
                                            {formatIota(stake.principal)} IOTA
                                        </span>
                                    </div>
                                    {stake.estimatedReward && (
                                        <div className="stake-detail">
                                            <span className="label">Est. Reward</span>
                                            <span className="value reward">
                                                +{formatIota(stake.estimatedReward)} IOTA
                                            </span>
                                        </div>
                                    )}
                                    <div className="stake-detail">
                                        <span className="label">Validator</span>
                                        <span className="value mono">
                                            {name
                                                ? name
                                                : `${stake.validatorAddress.slice(0, 10)}...${stake.validatorAddress.slice(-6)}`}
                                        </span>
                                    </div>
                                </div>
                                {isWhitelisted ? (
                                    <div style={{ display: 'flex', gap: '8px', flexDirection: 'column', alignItems: 'flex-end' }}>
                                        <button
                                            className="btn-stake"
                                            style={{ width: 'auto', padding: '8px 16px', fontSize: '0.85rem' }}
                                            onClick={() => handleDeposit(stake.stakedIotaId)}
                                            disabled={pendingAction === stake.stakedIotaId}
                                        >
                                            {pendingAction === stake.stakedIotaId ? 'Signing...' : 'Deposit'}
                                        </button>
                                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                                            <input
                                                type="number"
                                                placeholder="IOTA"
                                                value={swapAmounts[stake.stakedIotaId] ?? ''}
                                                onChange={(e) => setSwapAmounts((prev) => ({ ...prev, [stake.stakedIotaId]: e.target.value }))}
                                                style={{ width: '80px', padding: '6px 8px', fontSize: '0.8rem' }}
                                                min={1}
                                                step="0.1"
                                            />
                                            <button
                                                className="btn-max"
                                                style={{ padding: '6px 8px', fontSize: '0.75rem' }}
                                                onClick={() => setSwapAmounts((prev) => ({
                                                    ...prev,
                                                    [stake.stakedIotaId]: (Number(stake.principal) / 1e9).toString(),
                                                }))}
                                            >
                                                MAX
                                            </button>
                                            <button
                                                className="btn-stake"
                                                style={{ width: 'auto', padding: '6px 12px', fontSize: '0.8rem', background: '#8e44ad' }}
                                                onClick={() => {
                                                    const raw = swapAmounts[stake.stakedIotaId];
                                                    const amt = parseFloat(raw);
                                                    const principalNanos = BigInt(stake.principal);
                                                    if (!raw || isNaN(amt) || amt <= 0) {
                                                        setStatus({ type: 'error', msg: 'Enter an amount to swap' });
                                                        return;
                                                    }
                                                    const nanos = BigInt(Math.floor(amt * 1e9));
                                                    if (nanos > principalNanos) {
                                                        setStatus({ type: 'error', msg: 'Amount exceeds stake principal' });
                                                        return;
                                                    }
                                                    handleSwap(stake.stakedIotaId, principalNanos, nanos);
                                                }}
                                                disabled={pendingAction === `swap-${stake.stakedIotaId}`}
                                            >
                                                {pendingAction === `swap-${stake.stakedIotaId}` ? 'Signing...' : 'Swap'}
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <button
                                        className="btn-stake"
                                        style={{ width: 'auto', padding: '8px 16px', fontSize: '0.85rem', background: '#e67e22' }}
                                        onClick={() => handleAddValidator(stake.validatorAddress, stake.stakingPool)}
                                        disabled={pendingAction === addKey}
                                    >
                                        {pendingAction === addKey ? 'Signing...' : 'Add Validator'}
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
            {status && <p className={`status-msg ${status.type}`}>{status.msg}</p>}
        </div>
    );
}

function WithdrawSection({ address }: { address: string }) {
    const [amount, setAmount] = useState('');
    const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

    const iotaClient = useIotaClient();
    const queryClient = useQueryClient();
    const { mutate: signAndExecute, isPending: isSigning } = useSignAndExecuteTransaction();

    const { data: balance } = useIotaClientQuery('getBalance', {
        owner: address,
        coinType: RIOTA_COIN_TYPE,
    });
    const { data: coins } = useIotaClientQuery('getCoins', {
        owner: address,
        coinType: RIOTA_COIN_TYPE,
    });

    const totalBalanceNanos = BigInt(balance?.totalBalance ?? '0');
    const coinObjectIds = coins?.data?.map((c) => c.coinObjectId) ?? [];

    async function handleWithdraw() {
        setStatus(null);
        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
            setStatus({ type: 'error', msg: 'Enter a valid amount' });
            return;
        }

        const nanos = BigInt(Math.floor(amountNum * 10 ** 9));
        if (nanos > totalBalanceNanos) {
            setStatus({ type: 'error', msg: 'Insufficient rIOTA balance' });
            return;
        }
        if (coinObjectIds.length === 0) {
            setStatus({ type: 'error', msg: 'No rIOTA coins found' });
            return;
        }

        const tx = createLspWithdrawTransaction(coinObjectIds, nanos, totalBalanceNanos);
        tx.setSender(address);
        await tx.build({ client: iotaClient });
        signAndExecute(
            { transaction: tx },
            {
                onSuccess: async ({ digest }) => {
                    const txCheck = await waitAndCheckTx(iotaClient, digest);
                    await queryClient.invalidateQueries({
                        predicate: (query) => {
                            const key = query.queryKey;
                            return key[1] === 'getStakes' || key[1] === 'getBalance' || key[1] === 'getCoins'
                                || key[0] === 'lsp-pool-data' || key[0] === 'lsp-pool-value';
                        },
                    });
                    if (txCheck.ok) {
                        setStatus({ type: 'success', msg: 'Withdrawal successful! Check your wallet for StakedIota(s) and any rIOTA refund.' });
                        setAmount('');
                    } else {
                        setStatus({ type: 'error', msg: `Transaction failed: ${txCheck.error}` });
                    }
                },
                onError: (err) => {
                    setStatus({ type: 'error', msg: err.message });
                },
            },
        );
    }

    return (
        <div className="card stake-form-card">
            <h2>Withdraw rIOTA</h2>
            <p className="balance">
                rIOTA Balance: <strong>{formatIota(totalBalanceNanos.toString())} rIOTA</strong>
            </p>
            <div className="input-row">
                <input
                    type="number"
                    placeholder="Amount in rIOTA"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    min={0}
                    step="0.1"
                    disabled={isSigning}
                />
                <button
                    className="btn-max"
                    onClick={() => {
                        if (totalBalanceNanos > 0n) {
                            setAmount((Number(totalBalanceNanos) / 10 ** 9).toString());
                        }
                    }}
                    disabled={isSigning}
                >
                    MAX
                </button>
            </div>
            <button
                className="btn-stake"
                onClick={handleWithdraw}
                disabled={isSigning || !amount}
            >
                {isSigning ? 'Signing...' : 'Withdraw'}
            </button>
            {status && <p className={`status-msg ${status.type}`}>{status.msg}</p>}
        </div>
    );
}

export default LSPPage;
