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
}

interface StakeEntry {
    stakedIotaId: string;
    principal: bigint;
    estimatedReward: string | undefined;
    status: string;
    stakeActiveEpoch: string;
    currentValidator: ValidatorApyInfo | null;
    validatorAddress: string;
}

// ── Exchange rate APY fetching ───────────────────────────────────────

async function fetchExchangeRateApy(
    client: IotaClient,
    exchangeRatesId: string,
): Promise<{ perEpochYield: number; apy: number } | null> {
    try {
        // getDynamicFields returns entries ordered by objectId hash, NOT epoch.
        // We fetch a page and sort by epoch to find the two highest epochs.
        const fields = await client.getDynamicFields({
            parentId: exchangeRatesId,
            limit: 50,
        });

        if (fields.data.length < 2) return null;

        // Sort by epoch (name value) descending
        const sorted = [...fields.data].sort((a, b) => {
            const epochA = Number((a.name as { value: string }).value);
            const epochB = Number((b.name as { value: string }).value);
            return epochB - epochA;
        });

        const [latest, prev] = sorted;
        const epochCurr = Number((latest.name as { value: string }).value);
        const epochPrev = Number((prev.name as { value: string }).value);
        const epochGap = epochCurr - epochPrev;

        if (epochGap <= 0) return null;

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

        // Divide by epoch gap — the two entries may not be consecutive
        const totalYield = (rateCurr - ratePrev) / ratePrev;
        const perEpochYield = totalYield / epochGap;
        const apy = perEpochYield * 365 * 100; // 1 epoch = 1 day

        return { perEpochYield, apy: Math.max(0, apy) };
    } catch {
        return null;
    }
}

// ── Hook: fetch APY for ALL active validators ────────────────────────

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
                    });
                }),
            );

            return results;
        },
        enabled: validators.length > 0,
        staleTime: 60_000,
    });
}

// ── Break-even calculation helper ────────────────────────────────────

function computeBreakEven(
    principalIota: number,
    currentYield: number,
    targetYield: number,
) {
    const lostReward = principalIota * currentYield;
    const savingsPerEpoch = principalIota * (targetYield - currentYield);
    const breakEvenEpochs =
        savingsPerEpoch > 0 ? Math.ceil(lostReward / savingsPerEpoch) : Infinity;
    return { lostReward, savingsPerEpoch, breakEvenEpochs };
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

    // Fetch APYs for ALL active validators
    const { data: allApys, isPending: apysPending } =
        useAllValidatorApys(activeValidators);

    // Sorted validators list (by APY descending)
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
    }, [stakes, bestValidator, allApys]);

    const isLoading = systemPending || (account && stakesPending) || apysPending;

    return (
        <main className="main">
            <div className="card">
                <h2>Stake Optimizer</h2>
                <p className="hint" style={{ marginTop: 0, marginBottom: 16 }}>
                    Compares validators by <strong>actual APY</strong> computed from on-chain
                    exchange rates, not just commission.
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
                        epoch before it earns rewards. You effectively lose ~1 epoch of rewards
                        during the transition.
                    </div>
                    <div className="stakes-list">
                        {suggestions.map((s) => (
                            <SuggestionItem
                                key={s.stakedIotaId}
                                stake={s}
                                rankedValidators={rankedValidators}
                                bestValidator={bestValidator!}
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
                    <div className="validator-rankings">
                        <div className="rank-header">
                            <span className="rank-col-rank">#</span>
                            <span className="rank-col-name">Validator</span>
                            <span className="rank-col-comm">Comm.</span>
                            <span className="rank-col-apy">APY</span>
                        </div>
                        {rankedValidators.map((v, i) => (
                            <div
                                key={v.address}
                                className={`rank-row ${i === 0 ? 'rank-best' : ''}`}
                            >
                                <span className="rank-col-rank">{i + 1}</span>
                                <span className="rank-col-name">{v.name}</span>
                                <span className="rank-col-comm">{v.commission}%</span>
                                <span className="rank-col-apy">
                                    {v.apy > 0 ? `${v.apy.toFixed(2)}%` : '—'}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {apysPending && (
                <div className="card">Loading validator APYs...</div>
            )}
        </main>
    );
}

// ── Suggestion item with target selector + restake ───────────────────

function SuggestionItem({
    stake: s,
    rankedValidators,
    bestValidator,
}: {
    stake: StakeEntry;
    rankedValidators: ValidatorApyInfo[];
    bestValidator: ValidatorApyInfo;
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
    const { breakEvenEpochs } = computeBreakEven(principalIota, currentYield, targetValidator.perEpochYield);
    const apyDiff = targetValidator.apy - (s.currentValidator?.apy ?? 0);

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
                    <span className="label">Current</span>
                    <span className="value">
                        {s.currentValidator
                            ? `${s.currentValidator.name} — ${s.currentValidator.apy.toFixed(2)}% APY`
                            : `${s.validatorAddress.slice(0, 10)}... (candidate — no APY)`}
                    </span>
                </div>

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
                                {v.name} — {v.apy.toFixed(2)}% APY
                            </option>
                        ))}
                    </select>
                </div>

                {apyDiff > 0 && s.currentValidator && (
                    <div className="stake-detail">
                        <span className="label">Break-even</span>
                        <span className="value">
                            {breakEvenEpochs === Infinity
                                ? 'Never'
                                : `~${breakEvenEpochs} epochs (~${breakEvenEpochs} days)`}
                        </span>
                    </div>
                )}
                {apyDiff > 0 && (
                    <div className="stake-detail">
                        <span className="label">APY improvement</span>
                        <span className="value status-active">+{apyDiff.toFixed(2)}%</span>
                    </div>
                )}
                {apyDiff <= 0 && targetAddress !== s.validatorAddress && (
                    <div className="stake-detail">
                        <span className="label">APY change</span>
                        <span className="value" style={{ color: 'var(--error)' }}>
                            {apyDiff.toFixed(2)}% (worse or equal)
                        </span>
                    </div>
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
                            : `${s.validatorAddress.slice(0, 10)}... (candidate)`}
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
