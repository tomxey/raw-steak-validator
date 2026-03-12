import { useState, useMemo } from 'react';
import {
    useCurrentAccount,
    useIotaClientQuery,
    useIotaClient,
} from '@iota/dapp-kit';
import { useQuery } from '@tanstack/react-query';
import type { IotaClient, IotaValidatorSummary } from '@iota/iota-sdk/client';
import { formatIota } from './lib/utils';
import {
    computeValidatorApyHistory,
    type EpochRateEntry,
    type EpochYieldEntry,
} from './lib/apy';
import ValidatorDetail from './components/ValidatorDetail';

// ── Types ────────────────────────────────────────────────────────────

interface ValidatorApyInfo {
    address: string;
    name: string;
    commission: number;
    perEpochYield: number;
    apy: number;
    latestApy: number;
    avg7Apy: number;
    avg30Apy: number;
    isAnomalous: boolean;
    anomalyFactor: number;
    epochYields: EpochYieldEntry[];
    poolStake: number;
    pendingStake: number;
    pendingWithdraw: number;
}

interface StakeEntry {
    stakedIotaId: string;
    principal: bigint;
    estimatedReward: string | undefined;
    status: string;
    stakeActiveEpoch: string;
    validatorAddress: string;
    validatorName: string | null;
}

// ── Exchange rate history fetching ──────────────────────────────────

async function fetchExchangeRateHistory(
    client: IotaClient,
    exchangeRatesId: string,
): Promise<EpochRateEntry[]> {
    try {
        const fields = await client.getDynamicFields({
            parentId: exchangeRatesId,
            limit: 50,
        });

        if (fields.data.length < 2) return [];

        const sorted = [...fields.data].sort((a, b) => {
            const epochA = Number((a.name as { value: string }).value);
            const epochB = Number((b.name as { value: string }).value);
            return epochA - epochB;
        });

        const objects = await Promise.all(
            sorted.map((entry) =>
                client.getDynamicFieldObject({
                    parentObjectId: exchangeRatesId,
                    name: entry.name,
                    options: { showContent: true },
                }),
            ),
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entries: EpochRateEntry[] = [];
        for (let i = 0; i < sorted.length; i++) {
            const epoch = Number((sorted[i].name as { value: string }).value);
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

    const { data: allApys, isPending: apysPending } =
        useAllValidatorApys(activeValidators);

    const { data: candidateNames } = useCandidateValidatorNames(
        stakes, activeValidators, systemState?.validatorCandidatesId,
    );

    const [selectedValidator, setSelectedValidator] = useState<ValidatorApyInfo | null>(null);

    const rankedValidators = useMemo(() => {
        if (!allApys) return [];
        return [...allApys.values()].sort((a, b) => b.apy - a.apy);
    }, [allApys]);

    // Build simple stake list (no suggestions/optimal split)
    const stakeEntries = useMemo(() => {
        if (!stakes || !allApys) return [];

        const entries: StakeEntry[] = [];
        for (const group of stakes) {
            const currentInfo = allApys.get(group.validatorAddress) ?? null;
            const validatorName = currentInfo?.name
                ?? candidateNames?.get(group.validatorAddress)
                ?? null;

            for (const stake of group.stakes) {
                entries.push({
                    stakedIotaId: stake.stakedIotaId,
                    principal: BigInt(stake.principal),
                    estimatedReward: stake.status === 'Active' ? stake.estimatedReward : undefined,
                    status: stake.status,
                    stakeActiveEpoch: stake.stakeActiveEpoch,
                    validatorAddress: group.validatorAddress,
                    validatorName,
                });
            }
        }

        return entries;
    }, [stakes, allApys, candidateNames]);

    const isLoading = systemPending || (account && stakesPending) || apysPending;

    return (
        <main className="main">
            <div className="card">
                <h2>Validator Explorer</h2>
                <p className="hint" style={{ marginTop: 0, marginBottom: 16 }}>
                    Historical APY computed from on-chain exchange rates.
                </p>
            </div>

            {account && isLoading && (
                <div className="card">Loading stake data...</div>
            )}

            {account && !isLoading && stakeEntries.length > 0 && (
                <div className="card">
                    <h2>Your Stakes</h2>
                    <div className="stakes-list">
                        {stakeEntries.map((s) => (
                            <div key={s.stakedIotaId} className="stake-item optimizer-item">
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
                                            {s.validatorName ?? `${s.validatorAddress.slice(0, 10)}...`}
                                        </span>
                                    </div>
                                    <div className="stake-detail">
                                        <span className="label">Status</span>
                                        <span className={`value ${s.status !== 'Active' ? 'status-pending' : 'status-active'}`}>
                                            {s.status !== 'Active'
                                                ? `Pending (epoch ${s.stakeActiveEpoch})`
                                                : 'Active'}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {!apysPending && rankedValidators.length > 0 && (
                <div className="card">
                    <h2>Validators</h2>
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
                                className="rank-row rank-row-clickable"
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

            <div className="disclaimer">
                This data is provided for informational purposes only and does not constitute
                financial advice. Past performance does not indicate future results.
            </div>

            {selectedValidator && (
                <ValidatorDetail
                    validator={selectedValidator}
                    onClose={() => setSelectedValidator(null)}
                />
            )}
        </main>
    );
}
