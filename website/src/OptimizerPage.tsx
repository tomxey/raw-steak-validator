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

// ── Types ────────────────────────────────────────────────────────────

interface ValidatorApyInfo {
    address: string;
    name: string;
    commission: number; // percentage, e.g. 5 means 5%
    perEpochYield: number; // fractional, e.g. 0.0001
    apy: number; // annualized, e.g. 3.65 means 3.65%
    exchangeRatesId: string;
}

interface StakeSuggestion {
    stakedIotaId: string;
    principal: bigint;
    estimatedReward: string | undefined;
    status: string;
    stakeActiveEpoch: string;
    currentValidator: ValidatorApyInfo;
    bestValidator: ValidatorApyInfo;
    lostRewardIota: number;
    savingsPerEpoch: number;
    breakEvenEpochs: number;
}

// ── Exchange rate APY fetching ───────────────────────────────────────

async function fetchExchangeRateApy(
    client: IotaClient,
    exchangeRatesId: string,
): Promise<{ perEpochYield: number; apy: number } | null> {
    try {
        // Get the last page of dynamic fields (most recent epochs)
        const fields = await client.getDynamicFields({
            parentId: exchangeRatesId,
            limit: 50,
        });

        if (fields.data.length < 2) return null;

        // Sort by epoch (name value) descending and take the last 2
        const sorted = [...fields.data].sort((a, b) => {
            const epochA = Number((a.name as { value: string }).value);
            const epochB = Number((b.name as { value: string }).value);
            return epochB - epochA;
        });

        const [latest, prev] = sorted;

        // Fetch both dynamic field objects
        const [latestObj, prevObj] = await Promise.all([
            client.getDynamicFieldObject({
                parentObjectId: exchangeRatesId,
                name: latest.name,
                options: { showContent: true },
            }),
            client.getDynamicFieldObject({
                parentObjectId: exchangeRatesId,
                name: prev.name,
                options: { showContent: true },
            }),
        ]);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const extractRate = (obj: any): number | null => {
            const fields = obj?.data?.content?.fields?.value?.fields;
            if (!fields) return null;
            const iotaAmount = Number(fields.iota_amount);
            const poolTokenAmount = Number(fields.pool_token_amount);
            if (poolTokenAmount === 0) return null;
            return iotaAmount / poolTokenAmount;
        };

        const rateCurr = extractRate(latestObj);
        const ratePrev = extractRate(prevObj);

        if (rateCurr === null || ratePrev === null || ratePrev === 0) return null;

        const perEpochYield = (rateCurr - ratePrev) / ratePrev;
        const apy = perEpochYield * 365 * 100; // as percentage

        return { perEpochYield, apy: Math.max(0, apy) };
    } catch {
        return null;
    }
}

// ── Hook: fetch APY for a set of validators ──────────────────────────

function useValidatorApys(validators: IotaValidatorSummary[]) {
    const client = useIotaClient();

    // Pick which validators to fetch APY for:
    // - Top 10 lowest commission
    // - Will be merged with user's staked validators later
    const candidateAddresses = useMemo(() => {
        const sorted = [...validators].sort(
            (a, b) => Number(a.commissionRate) - Number(b.commissionRate),
        );
        return sorted.slice(0, 10).map((v) => v.iotaAddress);
    }, [validators]);

    return useQuery({
        queryKey: ['validator-apys', candidateAddresses.join(',')],
        queryFn: async () => {
            const results = new Map<string, ValidatorApyInfo>();

            // Build set of validators to query (candidates + dedup handled by caller)
            const toFetch = validators.filter((v) =>
                candidateAddresses.includes(v.iotaAddress),
            );

            await Promise.all(
                toFetch.map(async (v) => {
                    const apyData = await fetchExchangeRateApy(
                        client,
                        v.exchangeRatesId,
                    );
                    results.set(v.iotaAddress, {
                        address: v.iotaAddress,
                        name: v.name,
                        commission: Number(v.commissionRate) / 100,
                        perEpochYield: apyData?.perEpochYield ?? 0,
                        apy: apyData?.apy ?? 0,
                        exchangeRatesId: v.exchangeRatesId,
                    });
                }),
            );

            return results;
        },
        enabled: validators.length > 0,
        staleTime: 60_000,
    });
}

// ── Hook: fetch APY for extra validators (user's staked ones) ────────

function useExtraValidatorApys(
    validators: IotaValidatorSummary[],
    addresses: string[],
    existingApys: Map<string, ValidatorApyInfo> | undefined,
) {
    const client = useIotaClient();

    // Only fetch for addresses not already in existingApys
    const missingAddresses = useMemo(() => {
        if (!existingApys) return addresses;
        return addresses.filter((a) => !existingApys.has(a));
    }, [addresses, existingApys]);

    return useQuery({
        queryKey: ['extra-validator-apys', missingAddresses.join(',')],
        queryFn: async () => {
            const results = new Map<string, ValidatorApyInfo>();

            const toFetch = validators.filter((v) =>
                missingAddresses.includes(v.iotaAddress),
            );

            await Promise.all(
                toFetch.map(async (v) => {
                    const apyData = await fetchExchangeRateApy(
                        client,
                        v.exchangeRatesId,
                    );
                    results.set(v.iotaAddress, {
                        address: v.iotaAddress,
                        name: v.name,
                        commission: Number(v.commissionRate) / 100,
                        perEpochYield: apyData?.perEpochYield ?? 0,
                        apy: apyData?.apy ?? 0,
                        exchangeRatesId: v.exchangeRatesId,
                    });
                }),
            );

            return results;
        },
        enabled: missingAddresses.length > 0 && validators.length > 0,
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

    // Addresses of validators the user is staked with
    const stakedValidatorAddresses = useMemo(() => {
        if (!stakes) return [];
        return [...new Set(stakes.map((s) => s.validatorAddress))];
    }, [stakes]);

    // Fetch APYs for top-10 candidates
    const { data: candidateApys, isPending: apysPending } =
        useValidatorApys(activeValidators);

    // Fetch APYs for user's staked validators (if not already covered)
    const { data: extraApys } = useExtraValidatorApys(
        activeValidators,
        stakedValidatorAddresses,
        candidateApys,
    );

    // Merge all APYs
    const allApys = useMemo(() => {
        const merged = new Map<string, ValidatorApyInfo>();
        if (candidateApys) {
            for (const [k, v] of candidateApys) merged.set(k, v);
        }
        if (extraApys) {
            for (const [k, v] of extraApys) merged.set(k, v);
        }
        return merged;
    }, [candidateApys, extraApys]);

    // Find the best APY validator
    const bestValidator = useMemo(() => {
        let best: ValidatorApyInfo | null = null;
        for (const v of allApys.values()) {
            if (!best || v.apy > best.apy) best = v;
        }
        return best;
    }, [allApys]);

    // Build suggestions
    const { suggestions, optimal } = useMemo(() => {
        if (!stakes || !bestValidator || allApys.size === 0) {
            return { suggestions: [], optimal: [] };
        }

        const suggs: StakeSuggestion[] = [];
        const opt: StakeSuggestion[] = [];

        for (const group of stakes) {
            const currentInfo = allApys.get(group.validatorAddress);
            if (!currentInfo) continue;

            for (const stake of group.stakes) {
                const principal = BigInt(stake.principal);
                const principalIota = Number(principal) / 1e9;
                const isPending = stake.status !== 'Active';

                const lostRewardIota = principalIota * currentInfo.perEpochYield;
                const savingsPerEpoch =
                    principalIota * (bestValidator.perEpochYield - currentInfo.perEpochYield);
                const breakEvenEpochs =
                    savingsPerEpoch > 0
                        ? Math.ceil(lostRewardIota / savingsPerEpoch)
                        : Infinity;

                const entry: StakeSuggestion = {
                    stakedIotaId: stake.stakedIotaId,
                    principal,
                    estimatedReward: stake.status === 'Active' ? stake.estimatedReward : undefined,
                    status: stake.status,
                    stakeActiveEpoch: stake.stakeActiveEpoch,
                    currentValidator: currentInfo,
                    bestValidator,
                    lostRewardIota,
                    savingsPerEpoch,
                    breakEvenEpochs,
                };

                // Suggest restake if different validator and APY improvement > 0.01%
                if (
                    !isPending &&
                    currentInfo.address !== bestValidator.address &&
                    bestValidator.apy - currentInfo.apy > 0.01
                ) {
                    suggs.push(entry);
                } else {
                    opt.push(entry);
                }
            }
        }

        // Sort suggestions by savings (highest first)
        suggs.sort((a, b) => b.savingsPerEpoch - a.savingsPerEpoch);

        return { suggestions: suggs, optimal: opt };
    }, [stakes, bestValidator, allApys]);

    const isLoading = systemPending || stakesPending || apysPending;

    if (!account) {
        return (
            <main className="main">
                <div className="card connect-prompt">
                    <p>Connect your wallet to optimize your stakes</p>
                </div>
            </main>
        );
    }

    if (isLoading) {
        return (
            <main className="main">
                <div className="card">Loading stake data and validator APYs...</div>
            </main>
        );
    }

    if (!stakes || stakes.length === 0) {
        return (
            <main className="main">
                <div className="card">
                    <h2>Stake Optimizer</h2>
                    <p className="hint">
                        You have no stakes yet. <Link to="/">Stake IOTA</Link> to get started.
                    </p>
                </div>
            </main>
        );
    }

    return (
        <main className="main">
            <div className="card">
                <h2>Stake Optimizer</h2>
                <p className="hint" style={{ marginTop: 0, marginBottom: 16 }}>
                    Compares your stakes by <strong>actual APY</strong> (computed from on-chain
                    exchange rates), not just commission. Shows break-even epochs for restaking.
                </p>

                {bestValidator && (
                    <div className="optimizer-best">
                        <span className="label">Best available APY</span>
                        <span className="value status-active">
                            {bestValidator.apy.toFixed(2)}% — {bestValidator.name}
                        </span>
                    </div>
                )}
            </div>

            {suggestions.length > 0 && (
                <div className="card">
                    <h2>Suggestions</h2>
                    <div className="optimizer-warning">
                        Restaking moves your stake atomically, but the new stake is pending for ~1
                        epoch before it earns rewards. You effectively lose ~1 epoch of rewards
                        during the transition.
                    </div>
                    <div className="stakes-list">
                        {suggestions.map((s) => (
                            <SuggestionItem key={s.stakedIotaId} suggestion={s} />
                        ))}
                    </div>
                </div>
            )}

            {optimal.length > 0 && (
                <div className="card">
                    <h2>{suggestions.length > 0 ? 'Already Optimal' : 'Your Stakes'}</h2>
                    <div className="stakes-list">
                        {optimal.map((s) => (
                            <OptimalItem key={s.stakedIotaId} item={s} />
                        ))}
                    </div>
                </div>
            )}
        </main>
    );
}

// ── Suggestion item with restake button ──────────────────────────────

function SuggestionItem({ suggestion: s }: { suggestion: StakeSuggestion }) {
    const account = useCurrentAccount();
    const iotaClient = useIotaClient();
    const queryClient = useQueryClient();
    const { mutate: signAndExecute } = useSignAndExecuteTransaction();
    const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
    const [isPending, setIsPending] = useState(false);

    async function handleRestake() {
        if (!account) return;
        setStatus(null);
        setIsPending(true);

        const tx = createRestakeTransaction(
            s.stakedIotaId,
            s.bestValidator.address,
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
                    <span className="label">Current</span>
                    <span className="value">
                        {s.currentValidator.name} — {s.currentValidator.apy.toFixed(2)}% APY
                    </span>
                </div>
                <div className="stake-detail">
                    <span className="label">Best</span>
                    <span className="value status-active">
                        {s.bestValidator.name} — {s.bestValidator.apy.toFixed(2)}% APY
                    </span>
                </div>
                <div className="stake-detail">
                    <span className="label">Break-even</span>
                    <span className="value">
                        {s.breakEvenEpochs === Infinity
                            ? 'Never (no improvement)'
                            : `~${s.breakEvenEpochs} epochs`}
                    </span>
                </div>
            </div>
            <div className="optimizer-actions">
                <button
                    className="btn-restake"
                    onClick={handleRestake}
                    disabled={isPending}
                >
                    {isPending ? 'Signing...' : 'Restake'}
                </button>
            </div>
            {status && <p className={`status-msg ${status.type}`}>{status.msg}</p>}
        </div>
    );
}

// ── Optimal item (no action needed) ──────────────────────────────────

function OptimalItem({ item: s }: { item: StakeSuggestion }) {
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
                        {s.currentValidator.name} — {s.currentValidator.apy.toFixed(2)}% APY
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
