import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
    useCurrentAccount,
    useIotaClientQuery,
    useSignAndExecuteTransaction,
    useIotaClient,
} from '@iota/dapp-kit';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { IotaClient, IotaValidatorSummary } from '@iota/iota-sdk/client';
import { formatIota, waitAndCheckTx } from './lib/utils';
import { createRestakeTransaction } from './lib/transactions';
import {
    computeValidatorApyHistory,
    estimatePostRestakeYield,
    computeBreakEven,
    type EpochRateEntry,
    type EpochYieldEntry,
} from './lib/apy';
import ValidatorDetail from './components/ValidatorDetail';

// ── Types ────────────────────────────────────────────────────────────

interface ValidatorApyInfo {
    address: string;
    name: string;
    commission: number; // percentage, e.g. 5 means 5%
    perEpochYield: number; // avg7 per-epoch yield (for break-even)
    apy: number; // avg7 APY (primary ranking metric)
    latestApy: number; // single most recent epoch
    avg7Apy: number;
    avg30Apy: number;
    isAnomalous: boolean;
    anomalyFactor: number;
    epochYields: EpochYieldEntry[];
    poolStake: number; // total IOTA in the staking pool (in IOTA, not nanos)
    pendingStake: number; // pending incoming stake (IOTA)
    pendingWithdraw: number; // pending withdrawals (IOTA)
}

interface StakeEntry {
    stakedIotaId: string;
    principal: bigint;
    estimatedReward: string | undefined;
    status: string;
    stakeActiveEpoch: string;
    currentValidator: ValidatorApyInfo | null;
    validatorAddress: string;
    validatorName: string | null;
}

// ── Exchange rate history fetching ──────────────────────────────────

async function fetchExchangeRateHistory(
    client: IotaClient,
    exchangeRatesId: string,
): Promise<EpochRateEntry[]> {
    try {
        // Paginate to get ALL dynamic field entries (exchange rates are 1 per epoch)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const allFields: any[] = [];
        let cursor: string | null | undefined = undefined;
        let hasNext = true;
        while (hasNext) {
            const page = await client.getDynamicFields({
                parentId: exchangeRatesId,
                limit: 50,
                ...(cursor ? { cursor } : {}),
            });
            allFields.push(...page.data);
            hasNext = page.hasNextPage;
            cursor = page.nextCursor;
        }

        if (allFields.length < 2) return [];

        // Sort by epoch ascending
        const sorted = allFields.sort((a, b) => {
            const epochA = Number((a.name as { value: string }).value);
            const epochB = Number((b.name as { value: string }).value);
            return epochA - epochB;
        });

        // Only fetch the most recent 51 entries (50 yields need 51 rate points)
        const recent = sorted.length > 51 ? sorted.slice(-51) : sorted;

        const objects = await Promise.all(
            recent.map((entry) =>
                client.getDynamicFieldObject({
                    parentObjectId: exchangeRatesId,
                    name: entry.name,
                    options: { showContent: true },
                }),
            ),
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entries: EpochRateEntry[] = [];
        for (let i = 0; i < recent.length; i++) {
            const epoch = Number((recent[i].name as { value: string }).value);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const obj = objects[i]?.data?.content as any;
            const rateFields = obj?.fields?.value?.fields;
            if (!rateFields) continue;

            const iotaAmount = Number(rateFields.iota_amount);
            const poolTokenAmount = Number(rateFields.pool_token_amount);
            if (poolTokenAmount === 0) continue;

            entries.push({
                epoch,
                iotaAmount,
                poolTokenAmount,
                rate: iotaAmount / poolTokenAmount,
            });
        }

        return entries;
    } catch {
        return [];
    }
}

// ── Hook: fetch APY history for ALL active validators ───────────────

function useAllValidatorApys(validators: IotaValidatorSummary[]) {
    const client = useIotaClient();

    const validatorIds = useMemo(
        () => validators.map((v) => v.iotaAddress).sort().join(','),
        [validators],
    );

    return useQuery({
        queryKey: ['all-validator-apys', validatorIds],
        queryFn: async () => {
            const results = new Map<string, ValidatorApyInfo>();

            await Promise.all(
                validators.map(async (v) => {
                    const entries = await fetchExchangeRateHistory(
                        client,
                        v.exchangeRatesId,
                    );
                    const history = computeValidatorApyHistory(entries);

                    results.set(v.iotaAddress, {
                        address: v.iotaAddress,
                        name: v.name,
                        commission: Number(v.commissionRate) / 100,
                        perEpochYield: history.perEpochYield,
                        apy: history.avg7Apy,
                        latestApy: history.latestApy,
                        avg7Apy: history.avg7Apy,
                        avg30Apy: history.avg30Apy,
                        isAnomalous: history.isAnomalous,
                        anomalyFactor: history.anomalyFactor,
                        epochYields: history.epochYields,
                        poolStake: Number(v.stakingPoolIotaBalance) / 1e9,
                        pendingStake: Number(v.pendingStake) / 1e9,
                        pendingWithdraw: Number(v.pendingTotalIotaWithdraw) / 1e9,
                    });
                }),
            );

            return results;
        },
        enabled: validators.length > 0,
        staleTime: 60_000,
    });
}

// ── Hook: resolve names for candidate validators not in active set ───

function useCandidateValidatorNames(
    stakes: ReturnType<typeof useIotaClientQuery<'getStakes'>>['data'],
    activeValidators: IotaValidatorSummary[],
    candidatesTableId: string | undefined,
) {
    const client = useIotaClient();

    const unknownAddresses = useMemo(() => {
        if (!stakes) return [];
        const activeSet = new Set(activeValidators.map((v) => v.iotaAddress));
        const unknown = new Set<string>();
        for (const group of stakes) {
            if (!activeSet.has(group.validatorAddress)) {
                unknown.add(group.validatorAddress);
            }
        }
        return [...unknown];
    }, [stakes, activeValidators]);

    return useQuery({
        queryKey: ['candidate-validator-names', candidatesTableId, unknownAddresses.join(',')],
        queryFn: async () => {
            const names = new Map<string, string>();
            if (!candidatesTableId) return names;

            await Promise.all(
                unknownAddresses.map(async (addr) => {
                    try {
                        const res = await client.getDynamicFieldObject({
                            parentObjectId: candidatesTableId,
                            name: { type: 'address', value: addr },
                            options: { showContent: true },
                        });
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const content = res?.data?.content as any;
                        const name = content?.fields?.value?.fields?.metadata?.fields?.name as string | undefined;
                        if (name) names.set(addr, name);
                    } catch {
                        // Validator not found in candidates table
                    }
                }),
            );

            return names;
        },
        enabled: unknownAddresses.length > 0 && !!candidatesTableId,
        staleTime: 60_000,
    });
}

// ── Main component ───────────────────────────────────────────────────

export default function OptimizerPage() {
    const account = useCurrentAccount();
    const { data: systemState, isPending: systemPending } =
        useIotaClientQuery('getLatestIotaSystemState');

    const activeValidators = systemState?.activeValidators ?? [];

    const { data: stakes, isPending: stakesPending } = useIotaClientQuery(
        'getStakes',
        { owner: account?.address ?? '' },
        { enabled: !!account },
    );

    // Fetch APY history for ALL active validators
    const { data: allApys, isPending: apysPending } =
        useAllValidatorApys(activeValidators);

    // Resolve names for candidate validators not in the active set
    const { data: candidateNames } = useCandidateValidatorNames(
        stakes, activeValidators, systemState?.validatorCandidatesId,
    );

    // Validator detail modal state
    const [selectedValidator, setSelectedValidator] = useState<ValidatorApyInfo | null>(null);

    // Sorted validators list (by avg7 APY descending)
    const rankedValidators = useMemo(() => {
        if (!allApys) return [];
        return [...allApys.values()].sort((a, b) => b.apy - a.apy);
    }, [allApys]);

    // Find the best APY validator
    const bestValidator = rankedValidators.length > 0 ? rankedValidators[0] : null;

    // Build stake entries
    const { suggestions, optimal } = useMemo(() => {
        if (!stakes || !bestValidator || !allApys || allApys.size === 0) {
            return { suggestions: [], optimal: [] };
        }

        const suggs: StakeEntry[] = [];
        const opt: StakeEntry[] = [];

        for (const group of stakes) {
            const currentInfo = allApys.get(group.validatorAddress) ?? null;
            const validatorName = currentInfo?.name
                ?? candidateNames?.get(group.validatorAddress)
                ?? null;

            for (const stake of group.stakes) {
                const isPending = stake.status !== 'Active';

                const entry: StakeEntry = {
                    stakedIotaId: stake.stakedIotaId,
                    principal: BigInt(stake.principal),
                    estimatedReward: stake.status === 'Active' ? stake.estimatedReward : undefined,
                    status: stake.status,
                    stakeActiveEpoch: stake.stakeActiveEpoch,
                    currentValidator: currentInfo,
                    validatorAddress: group.validatorAddress,
                    validatorName,
                };

                const shouldSuggest =
                    !isPending &&
                    (currentInfo === null ||
                        (currentInfo.address !== bestValidator.address &&
                            bestValidator.apy - currentInfo.apy > 0.01));

                if (shouldSuggest) {
                    suggs.push(entry);
                } else {
                    opt.push(entry);
                }
            }
        }

        return { suggestions: suggs, optimal: opt };
    }, [stakes, bestValidator, allApys, candidateNames]);

    const isLoading = systemPending || (account && stakesPending) || apysPending;

    return (
        <main className="main">
            <div className="card">
                <h2>Stake Optimizer</h2>
                <p className="hint" style={{ marginTop: 0, marginBottom: 16 }}>
                    Compares validators by <strong>actual APY</strong> computed from on-chain
                    exchange rates (7-day average), not just commission.
                </p>

                {bestValidator && (
                    <div className="optimizer-best">
                        <span className="label">Best available APY (7d avg)</span>
                        <span className="value status-active">
                            {bestValidator.apy.toFixed(2)}% — {bestValidator.name}
                            {bestValidator.isAnomalous && (
                                <span className="anomaly-badge" title={`Latest epoch: ${bestValidator.latestApy.toFixed(2)}% (${bestValidator.anomalyFactor.toFixed(1)}x avg)`}>
                                    spike
                                </span>
                            )}
                        </span>
                    </div>
                )}
            </div>

            {!account && (
                <div className="card connect-prompt">
                    <p>Connect your wallet to see personalized restaking suggestions</p>
                </div>
            )}

            {account && isLoading && (
                <div className="card">Loading stake data...</div>
            )}

            {account && !isLoading && stakes && stakes.length === 0 && (
                <div className="card">
                    <p className="hint">
                        You have no stakes yet. <Link to="/">Stake IOTA</Link> to get started.
                    </p>
                </div>
            )}

            {account && !isLoading && suggestions.length > 0 && (
                <div className="card">
                    <h2>Suggestions</h2>
                    <div className="optimizer-warning">
                        Restaking moves your stake atomically, but the new stake is pending for ~1
                        epoch before it earns rewards. Rewards are credited at epoch boundaries
                        using the pre-epoch exchange rate, so you lose ~1 epoch of rewards during
                        the transition. The break-even estimate below uses 7-day average APY.
                    </div>
                    <div className="stakes-list">
                        {suggestions.map((s) => (
                            <SuggestionItem
                                key={s.stakedIotaId}
                                stake={s}
                                rankedValidators={rankedValidators}
                                bestValidator={bestValidator!}
                                totalNetworkStake={Number(systemState?.totalStake ?? '0') / 1e9}
                            />
                        ))}
                    </div>
                </div>
            )}

            {account && !isLoading && optimal.length > 0 && (
                <div className="card">
                    <h2>{suggestions.length > 0 ? 'Already Optimal' : 'Your Stakes'}</h2>
                    <div className="stakes-list">
                        {optimal.map((s) => (
                            <OptimalItem key={s.stakedIotaId} item={s} />
                        ))}
                    </div>
                </div>
            )}

            {!apysPending && rankedValidators.length > 0 && (
                <div className="card">
                    <h2>Validator Rankings</h2>
                    <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
                        Click a validator to see detailed yield history. Sorted by 7-day average APY.
                    </p>
                    <div className="validator-rankings">
                        <div className="rank-header">
                            <span className="rank-col-rank">#</span>
                            <span className="rank-col-name">Validator</span>
                            <span className="rank-col-comm">Comm.</span>
                            <span className="rank-col-apy">7d APY</span>
                            <span className="rank-col-apy">30d APY</span>
                            <span className="rank-col-apy">Latest</span>
                        </div>
                        {rankedValidators.map((v, i) => (
                            <div
                                key={v.address}
                                className={`rank-row rank-row-clickable ${i === 0 ? 'rank-best' : ''}`}
                                onClick={() => setSelectedValidator(v)}
                            >
                                <span className="rank-col-rank">{i + 1}</span>
                                <span className="rank-col-name">
                                    {v.name}
                                    {v.isAnomalous && (
                                        <span className="anomaly-badge" title={`Latest epoch APY is ${v.anomalyFactor.toFixed(1)}x the 30-day average`}>
                                            spike
                                        </span>
                                    )}
                                </span>
                                <span className="rank-col-comm">{v.commission}%</span>
                                <span className="rank-col-apy">
                                    {v.avg7Apy > 0 ? `${v.avg7Apy.toFixed(2)}%` : '—'}
                                </span>
                                <span className="rank-col-apy">
                                    {v.avg30Apy > 0 ? `${v.avg30Apy.toFixed(2)}%` : '—'}
                                </span>
                                <span className={`rank-col-apy ${v.isAnomalous ? 'apy-anomalous' : ''}`}>
                                    {v.latestApy > 0 ? `${v.latestApy.toFixed(2)}%` : '—'}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {apysPending && (
                <div className="card">Loading validator APYs...</div>
            )}

            {selectedValidator && (
                <ValidatorDetail
                    validator={selectedValidator}
                    onClose={() => setSelectedValidator(null)}
                />
            )}
        </main>
    );
}

// ── Suggestion item with target selector + restake ───────────────────

function SuggestionItem({
    stake: s,
    rankedValidators,
    bestValidator,
    totalNetworkStake,
}: {
    stake: StakeEntry;
    rankedValidators: ValidatorApyInfo[];
    bestValidator: ValidatorApyInfo;
    totalNetworkStake: number;
}) {
    const [targetAddress, setTargetAddress] = useState(bestValidator.address);
    const account = useCurrentAccount();
    const iotaClient = useIotaClient();
    const queryClient = useQueryClient();
    const { mutate: signAndExecute } = useSignAndExecuteTransaction();
    const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
    const [isPending, setIsPending] = useState(false);

    const targetValidator = rankedValidators.find((v) => v.address === targetAddress) ?? bestValidator;
    const principalIota = Number(s.principal) / 1e9;
    const currentYield = s.currentValidator?.perEpochYield ?? 0;
    const currentRewardPerEpoch = principalIota * currentYield;

    // Estimate post-restake yields accounting for stake shift and pending operations
    const { estTargetYield, estTargetApy } = estimatePostRestakeYield(
        s.currentValidator, targetValidator, principalIota, totalNetworkStake,
    );
    const estRewardPerEpoch = principalIota * estTargetYield;
    const rewardDiffPerEpoch = estRewardPerEpoch - currentRewardPerEpoch;
    const { lostReward, breakEvenEpochs } = computeBreakEven(principalIota, currentYield, estTargetYield);
    const apyDiff = estTargetApy - (s.currentValidator?.apy ?? 0);

    async function handleRestake() {
        if (!account) return;
        setStatus(null);
        setIsPending(true);

        const tx = createRestakeTransaction(
            s.stakedIotaId,
            targetAddress,
            account.address,
        );
        tx.setSender(account.address);
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
                        setStatus({ type: 'success', msg: 'Restaked successfully!' });
                    } else {
                        setStatus({ type: 'error', msg: `Failed: ${txCheck.error}` });
                    }
                    setIsPending(false);
                },
                onError: (err) => {
                    setStatus({ type: 'error', msg: err.message });
                    setIsPending(false);
                },
            },
        );
    }

    return (
        <div className="stake-item optimizer-item">
            <div className="stake-info">
                <div className="stake-detail">
                    <span className="label">Principal</span>
                    <span className="value">{formatIota(s.principal)} IOTA</span>
                </div>
                {s.estimatedReward && (
                    <div className="stake-detail">
                        <span className="label">Accumulated Reward</span>
                        <span className="value reward">+{formatIota(s.estimatedReward)} IOTA</span>
                    </div>
                )}
                <div className="stake-detail">
                    <span className="label">Current validator</span>
                    <span className="value">
                        {s.currentValidator
                            ? <>
                                {s.currentValidator.name} — {s.currentValidator.apy.toFixed(2)}% APY
                                {s.currentValidator.isAnomalous && (
                                    <span className="anomaly-badge">spike</span>
                                )}
                            </>
                            : `${s.validatorName ?? `${s.validatorAddress.slice(0, 10)}...`} (candidate — no APY)`}
                    </span>
                </div>
                {s.currentValidator && (
                    <div className="stake-detail">
                        <span className="label">Current reward/epoch</span>
                        <span className="value">~{currentRewardPerEpoch.toFixed(4)} IOTA</span>
                    </div>
                )}

                <div className="stake-detail target-row">
                    <span className="label">Restake to</span>
                    <select
                        className="target-select"
                        value={targetAddress}
                        onChange={(e) => setTargetAddress(e.target.value)}
                        disabled={isPending}
                    >
                        {rankedValidators.map((v) => (
                            <option key={v.address} value={v.address}>
                                {v.name} — {v.apy.toFixed(2)}% APY (7d avg)
                            </option>
                        ))}
                    </select>
                </div>

                {targetAddress !== s.validatorAddress && (
                    <>
                        <div className="stake-detail">
                            <span className="label">Est. APY after restake</span>
                            <span className={`value ${apyDiff > 0 ? 'status-active' : ''}`} style={apyDiff <= 0 ? { color: 'var(--error)' } : undefined}>
                                {estTargetApy.toFixed(2)}%{' '}
                                <span className="hint-inline">
                                    ({apyDiff >= 0 ? '+' : ''}{apyDiff.toFixed(2)}% vs current, was {targetValidator.apy.toFixed(2)}% 7d avg)
                                </span>
                            </span>
                        </div>
                        <div className="stake-detail">
                            <span className="label">Est. reward/epoch after</span>
                            <span className={`value ${rewardDiffPerEpoch > 0 ? 'status-active' : ''}`} style={rewardDiffPerEpoch <= 0 ? { color: 'var(--error)' } : undefined}>
                                ~{estRewardPerEpoch.toFixed(4)} IOTA{' '}
                                <span className="hint-inline">
                                    ({rewardDiffPerEpoch >= 0 ? '+' : ''}{rewardDiffPerEpoch.toFixed(4)} IOTA/epoch)
                                </span>
                            </span>
                        </div>
                        {s.currentValidator && (
                            <div className="break-even-info">
                                <div className="stake-detail">
                                    <span className="label">Lost reward (1 epoch)</span>
                                    <span className="value" style={{ color: 'var(--error)' }}>
                                        ~{lostReward.toFixed(4)} IOTA
                                    </span>
                                </div>
                                <div className="stake-detail">
                                    <span className="label">Break-even</span>
                                    <span className="value" style={breakEvenEpochs === Infinity ? { color: 'var(--error)' } : undefined}>
                                        {breakEvenEpochs === Infinity
                                            ? apyDiff <= 0 ? 'Never — estimated APY is worse or equal' : 'Never'
                                            : `~${breakEvenEpochs} epoch${breakEvenEpochs !== 1 ? 's' : ''} (~${breakEvenEpochs} day${breakEvenEpochs !== 1 ? 's' : ''})`}
                                    </span>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
            <div className="optimizer-actions">
                <button
                    className="btn-restake"
                    onClick={handleRestake}
                    disabled={isPending || targetAddress === s.validatorAddress}
                >
                    {isPending ? 'Signing...' : 'Restake'}
                </button>
            </div>
            {status && <p className={`status-msg ${status.type}`}>{status.msg}</p>}
        </div>
    );
}

// ── Optimal item (no action needed) ──────────────────────────────────

function OptimalItem({ item: s }: { item: StakeEntry }) {
    const isPending = s.status !== 'Active';

    return (
        <div className="stake-item optimizer-item">
            <div className="stake-info">
                <div className="stake-detail">
                    <span className="label">Principal</span>
                    <span className="value">{formatIota(s.principal)} IOTA</span>
                </div>
                {s.estimatedReward && (
                    <div className="stake-detail">
                        <span className="label">Accumulated Reward</span>
                        <span className="value reward">+{formatIota(s.estimatedReward)} IOTA</span>
                    </div>
                )}
                <div className="stake-detail">
                    <span className="label">Validator</span>
                    <span className="value">
                        {s.currentValidator
                            ? `${s.currentValidator.name} — ${s.currentValidator.apy.toFixed(2)}% APY`
                            : `${s.validatorName ?? `${s.validatorAddress.slice(0, 10)}...`} (candidate)`}
                    </span>
                </div>
                <div className="stake-detail">
                    <span className="label">Status</span>
                    <span className={`value ${isPending ? 'status-pending' : 'status-active'}`}>
                        {isPending
                            ? `Pending (epoch ${s.stakeActiveEpoch})`
                            : 'Active — Optimal'}
                    </span>
                </div>
            </div>
        </div>
    );
}
