import { useState } from 'react';
import {
    useCurrentAccount,
    useIotaClientQuery,
    useSignAndExecuteTransaction,
    useIotaClient,
} from '@iota/dapp-kit';
import { useQueryClient } from '@tanstack/react-query';
import { RIOTA_COIN_TYPE } from './constants';
import { createLspDepositTransaction, createLspWithdrawTransaction } from './lib/transactions';
import { formatIota, waitAndCheckTx } from './lib/utils';

function LSPPage() {
    const account = useCurrentAccount();

    if (!account) {
        return (
            <main className="main">
                <div className="card connect-prompt">
                    <p>Connect your wallet to use the Liquid Staking Pool</p>
                </div>
            </main>
        );
    }

    return (
        <main className="main">
            <DepositSection address={account.address} />
            <WithdrawSection address={account.address} />
        </main>
    );
}

function DepositSection({ address }: { address: string }) {
    const { data: stakes, isPending } = useIotaClientQuery('getStakes', { owner: address });
    const [pendingDeposit, setPendingDeposit] = useState<string | null>(null);
    const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

    const iotaClient = useIotaClient();
    const queryClient = useQueryClient();
    const { mutate: signAndExecute } = useSignAndExecuteTransaction();

    // Collect all active stakes across all validators
    const allStakes = stakes?.flatMap((s) =>
        s.stakes
            .filter((stake) => stake.status === 'Active')
            .map((stake) => ({
                ...stake,
                validatorAddress: s.validatorAddress,
            })),
    ) ?? [];

    async function handleDeposit(stakedIotaId: string) {
        setStatus(null);
        setPendingDeposit(stakedIotaId);
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
                            return key[1] === 'getStakes' || key[1] === 'getBalance' || key[1] === 'getCoins';
                        },
                    });
                    if (txCheck.ok) {
                        setStatus({ type: 'success', msg: 'Deposit successful! You received rIOTA.' });
                    } else {
                        setStatus({ type: 'error', msg: `Transaction failed: ${txCheck.error}` });
                    }
                    setPendingDeposit(null);
                },
                onError: (err) => {
                    setStatus({ type: 'error', msg: err.message });
                    setPendingDeposit(null);
                },
            },
        );
    }

    if (isPending) return <div className="card">Loading your stakes...</div>;

    return (
        <div className="card">
            <h2>Deposit StakedIota</h2>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
                Deposit active StakedIota to mint rIOTA. Only stakes from whitelisted validators are accepted.
            </p>
            {allStakes.length === 0 ? (
                <p className="hint">You have no active stakes to deposit.</p>
            ) : (
                <div className="stakes-list">
                    {allStakes.map((stake) => (
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
                                        {stake.validatorAddress.slice(0, 10)}...{stake.validatorAddress.slice(-6)}
                                    </span>
                                </div>
                            </div>
                            <button
                                className="btn-stake"
                                style={{ width: 'auto', padding: '8px 16px', fontSize: '0.85rem' }}
                                onClick={() => handleDeposit(stake.stakedIotaId)}
                                disabled={pendingDeposit === stake.stakedIotaId}
                            >
                                {pendingDeposit === stake.stakedIotaId ? 'Signing...' : 'Deposit'}
                            </button>
                        </div>
                    ))}
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
                            return key[1] === 'getStakes' || key[1] === 'getBalance' || key[1] === 'getCoins';
                        },
                    });
                    if (txCheck.ok) {
                        setStatus({ type: 'success', msg: 'Withdrawal successful! You received StakedIota.' });
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
