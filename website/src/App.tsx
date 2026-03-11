import { useState } from 'react';
import {
    ConnectButton,
    useCurrentAccount,
    useIotaClientQuery,
    useSignAndExecuteTransaction,
    useIotaClient,
} from '@iota/dapp-kit';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    VALIDATOR_ADDRESS,
    IOTA_DECIMALS,
    MIN_STAKE_IOTA,
    GAS_BUDGET_NANOS,
    VALIDATOR_INNER_ID,
} from './constants';
import { createStakeTransaction, createUnstakeTransaction } from './lib/transactions';
import './App.css';

async function waitAndCheckTx(
    iotaClient: ReturnType<typeof useIotaClient>,
    digest: string,
): Promise<{ ok: boolean; error?: string }> {
    try {
        await iotaClient.waitForTransaction({ digest, timeout: 30_000 });
    } catch {
        // RPC may not have indexed it yet — still check status
    }
    try {
        const result = await iotaClient.getTransactionBlock({
            digest,
            options: { showEffects: true },
        });
        const status = result.effects?.status;
        if (status?.status === 'failure') {
            return { ok: false, error: status.error ?? 'Transaction failed on-chain' };
        }
        return { ok: true };
    } catch {
        // Can't verify — assume success since the tx was submitted
        return { ok: true };
    }
}

function formatIota(nanos: string | bigint, decimals?: number): string {
    const val = BigInt(nanos);
    const whole = val / BigInt(10 ** IOTA_DECIMALS);
    if (decimals === 0) return whole.toLocaleString();
    const frac = val % BigInt(10 ** IOTA_DECIMALS);
    const fracStr = frac.toString().padStart(IOTA_DECIMALS, '0').replace(/0+$/, '');
    if (decimals !== undefined && fracStr) {
        return `${whole.toLocaleString()}.${fracStr.slice(0, decimals)}`;
    }
    return fracStr ? `${whole.toLocaleString()}.${fracStr}` : whole.toLocaleString();
}

function App() {
    const account = useCurrentAccount();

    return (
        <div className="app">
            <header className="header">
                <div className="header-brand">
                    <span className="logo">🥩</span>
                    <h1>Raw Steak Validator</h1>
                </div>
                <ConnectButton />
            </header>

            <main className="main">
                <ValidatorInfo />
                {account ? (
                    <>
                        <StakeForm address={account.address} />
                        <MyStakes address={account.address} />
                    </>
                ) : (
                    <div className="card connect-prompt">
                        <p>Connect your wallet to stake IOTA</p>
                    </div>
                )}
            </main>

            <footer className="footer">
                <p>raw-steak.eu — IOTA Mainnet Validator</p>
            </footer>
        </div>
    );
}

function useCandidateStake() {
    const client = useIotaClient();
    return useQuery({
        queryKey: ['candidate-stake', VALIDATOR_INNER_ID],
        queryFn: async () => {
            const res = await client.getDynamicFieldObject({
                parentObjectId: VALIDATOR_INNER_ID,
                name: { type: 'u64', value: '1' },
                options: { showContent: true },
            });
            // Navigate: content.fields.value.fields.staking_pool.fields.iota_balance
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const content = res?.data?.content as any;
            return content?.fields?.value?.fields?.staking_pool?.fields?.iota_balance as
                | string
                | undefined;
        },
        staleTime: 30_000,
    });
}

function StakeProgress({ totalStaked, target }: { totalStaked: bigint; target: bigint }) {
    const pct = Number((totalStaked * 100n) / target);
    const clampedPct = Math.min(pct, 100);
    const isComplete = totalStaked >= target;

    return (
        <div className="stake-progress">
            <div className="progress-header">
                <span className="label">Stake Progress</span>
                <span className="value">
                    {formatIota(totalStaked.toString(), 0)} / {formatIota(target.toString(), 0)} IOTA
                </span>
            </div>
            <div className="progress-bar-bg">
                <div
                    className={`progress-bar-fill ${isComplete ? 'complete' : ''}`}
                    style={{ width: `${clampedPct}%` }}
                />
            </div>
            <div className="progress-footer">
                <span className={isComplete ? 'status-active' : 'status-candidate'}>
                    {isComplete ? 'Threshold reached' : `${pct}% — ${formatIota((target - totalStaked).toString(), 0)} IOTA remaining`}
                </span>
            </div>
        </div>
    );
}

function ValidatorInfo() {
    const { data: systemState, isPending } = useIotaClientQuery('getLatestIotaSystemState');
    const { data: candidateStake } = useCandidateStake();

    if (isPending) return <div className="card">Loading validator info...</div>;

    const validator = systemState?.activeValidators?.find(
        (v) => v.iotaAddress === VALIDATOR_ADDRESS,
    );
    const minJoiningStake = BigInt(systemState?.minValidatorJoiningStake ?? '2000000000000000');

    if (!validator) {
        const totalStaked = candidateStake ? BigInt(candidateStake) : null;

        return (
            <div className="card validator-card">
                <h2>Validator</h2>
                <div className="validator-detail">
                    <span className="label">Address</span>
                    <span className="value mono">
                        {VALIDATOR_ADDRESS.slice(0, 10)}...{VALIDATOR_ADDRESS.slice(-8)}
                    </span>
                </div>
                <div className="validator-detail">
                    <span className="label">Status</span>
                    <span className="value status-candidate">Candidate</span>
                </div>
                {totalStaked !== null && (
                    <div className="validator-detail">
                        <span className="label">Total Staked</span>
                        <span className="value">{formatIota(totalStaked.toString())} IOTA</span>
                    </div>
                )}
                {totalStaked !== null && (
                    <StakeProgress totalStaked={totalStaked} target={minJoiningStake} />
                )}
                <p className="hint">
                    This validator is a candidate. Stake to help it reach the {formatIota(minJoiningStake.toString())} IOTA
                    threshold and join the active validator set.
                </p>
            </div>
        );
    }

    const commissionRate = Number(validator.commissionRate) / 100;
    const totalStaked = BigInt(validator.stakingPoolIotaBalance);

    return (
        <div className="card validator-card">
            <h2>Validator Info</h2>
            <div className="validator-detail">
                <span className="label">Name</span>
                <span className="value">{validator.name}</span>
            </div>
            <div className="validator-detail">
                <span className="label">Status</span>
                <span className="value status-active">Active</span>
            </div>
            <div className="validator-detail">
                <span className="label">Commission</span>
                <span className="value">{commissionRate}%</span>
            </div>
            <div className="validator-detail">
                <span className="label">Total Staked</span>
                <span className="value">{formatIota(totalStaked.toString())} IOTA</span>
            </div>
            <StakeProgress totalStaked={totalStaked} target={minJoiningStake} />
            {validator.description && (
                <div className="validator-detail">
                    <span className="label">Description</span>
                    <span className="value">{validator.description}</span>
                </div>
            )}
        </div>
    );
}

function StakeForm({ address }: { address: string }) {
    const [amount, setAmount] = useState('');
    const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

    const iotaClient = useIotaClient();
    const queryClient = useQueryClient();
    const { mutate: signAndExecute, isPending: isSigning } = useSignAndExecuteTransaction();
    const { data: balance } = useIotaClientQuery('getBalance', { owner: address });

    const balanceNanos = BigInt(balance?.totalBalance ?? '0');

    async function handleStake() {
        setStatus(null);
        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum < MIN_STAKE_IOTA) {
            setStatus({ type: 'error', msg: `Minimum stake is ${MIN_STAKE_IOTA} IOTA` });
            return;
        }

        const nanos = BigInt(Math.floor(amountNum * 10 ** IOTA_DECIMALS));
        if (nanos + GAS_BUDGET_NANOS > balanceNanos) {
            setStatus({ type: 'error', msg: `Insufficient balance (need ${formatIota((nanos + GAS_BUDGET_NANOS).toString())} IOTA including gas)` });
            return;
        }

        const tx = createStakeTransaction(nanos, VALIDATOR_ADDRESS);
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
                            return key[1] === 'getStakes' || key[1] === 'getBalance';
                        },
                    });
                    if (txCheck.ok) {
                        setStatus({ type: 'success', msg: 'Stake submitted successfully!' });
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
            <h2>Stake IOTA</h2>
            <p className="balance">
                Available: <strong>{formatIota(balanceNanos.toString())} IOTA</strong>
            </p>
            <div className="input-row">
                <input
                    type="number"
                    placeholder={`Min ${MIN_STAKE_IOTA} IOTA`}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    min={MIN_STAKE_IOTA}
                    step="0.1"
                    disabled={isSigning}
                />
                <button
                    className="btn-max"
                    onClick={() => {
                        const maxNanos = balanceNanos - GAS_BUDGET_NANOS;
                        if (maxNanos > 0) {
                            setAmount((Number(maxNanos) / 10 ** IOTA_DECIMALS).toString());
                        }
                    }}
                    disabled={isSigning}
                >
                    MAX
                </button>
            </div>
            <button className="btn-stake" onClick={handleStake} disabled={isSigning || !amount}>
                {isSigning ? 'Signing...' : 'Stake'}
            </button>
            {status && <p className={`status-msg ${status.type}`}>{status.msg}</p>}
        </div>
    );
}

function MyStakes({ address }: { address: string }) {
    const { data: stakes, isPending } = useIotaClientQuery('getStakes', { owner: address });
    const [pendingUnstake, setPendingUnstake] = useState<string | null>(null);
    const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

    const iotaClient = useIotaClient();
    const queryClient = useQueryClient();
    const { mutate: signAndExecute } = useSignAndExecuteTransaction();

    // Filter stakes for our validator
    const validatorStakes = stakes?.filter(
        (s) => s.validatorAddress === VALIDATOR_ADDRESS,
    );
    const stakeEntries = validatorStakes?.flatMap((s) => s.stakes) ?? [];

    async function handleUnstake(stakedIotaId: string) {
        setStatus(null);
        setPendingUnstake(stakedIotaId);
        const tx = createUnstakeTransaction(stakedIotaId);
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
                            return key[1] === 'getStakes' || key[1] === 'getBalance';
                        },
                    });
                    if (txCheck.ok) {
                        setStatus({ type: 'success', msg: 'Unstake submitted successfully!' });
                    } else {
                        setStatus({ type: 'error', msg: `Transaction failed: ${txCheck.error}` });
                    }
                    setPendingUnstake(null);
                },
                onError: (err) => {
                    setStatus({ type: 'error', msg: err.message });
                    setPendingUnstake(null);
                },
            },
        );
    }

    if (isPending) return <div className="card">Loading your stakes...</div>;

    return (
        <div className="card my-stakes-card">
            <h2>My Stakes</h2>
            {stakeEntries.length === 0 ? (
                <p className="hint">You have no stakes with this validator yet.</p>
            ) : (
                <div className="stakes-list">
                    {stakeEntries.map((stake) => (
                        <div key={stake.stakedIotaId} className="stake-item">
                            <div className="stake-info">
                                <div className="stake-detail">
                                    <span className="label">Principal</span>
                                    <span className="value">
                                        {formatIota(stake.principal)} IOTA
                                    </span>
                                </div>
                                {stake.status === 'Active' && stake.estimatedReward && (
                                    <div className="stake-detail">
                                        <span className="label">Estimated Reward</span>
                                        <span className="value reward">
                                            +{formatIota(stake.estimatedReward)} IOTA
                                        </span>
                                    </div>
                                )}
                                <div className="stake-detail">
                                    <span className="label">Status</span>
                                    <span
                                        className={`value ${stake.status === 'Active' ? 'status-active' : 'status-pending'}`}
                                    >
                                        {stake.status === 'Active'
                                            ? 'Active'
                                            : `Pending (activates epoch ${stake.stakeActiveEpoch})`}
                                    </span>
                                </div>
                            </div>
                            <button
                                className="btn-unstake"
                                onClick={() => handleUnstake(stake.stakedIotaId)}
                                disabled={pendingUnstake === stake.stakedIotaId}
                            >
                                {pendingUnstake === stake.stakedIotaId
                                    ? 'Signing...'
                                    : 'Unstake'}
                            </button>
                        </div>
                    ))}
                </div>
            )}
            {status && <p className={`status-msg ${status.type}`}>{status.msg}</p>}
        </div>
    );
}

export default App;
