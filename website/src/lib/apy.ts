// ── Types ────────────────────────────────────────────────────────────

/** A single epoch's exchange rate data point (parsed from on-chain data) */
export interface EpochRateEntry {
    epoch: number;
    iotaAmount: number;
    poolTokenAmount: number;
    rate: number; // iotaAmount / poolTokenAmount
}

/** Per-epoch yield computed between two consecutive rate entries */
export interface EpochYieldEntry {
    epoch: number; // the epoch this yield applies to
    perEpochYield: number; // fractional yield for this single epoch
    annualizedApy: number; // perEpochYield * 365 * 100
}

/** Full history + averaged APYs for a validator */
export interface ValidatorApyHistory {
    epochYields: EpochYieldEntry[];
    latestApy: number; // single most recent epoch, annualized
    avg7Apy: number; // simple average of last 7 epochs, annualized
    avg30Apy: number; // simple average of last 30 epochs, annualized
    perEpochYield: number; // avg7 per-epoch yield (for break-even)
    isAnomalous: boolean; // latest deviates significantly from avg30
    anomalyFactor: number; // latestApy / avg30Apy (e.g. 3.0 = 3x)
}

/** Validator info used for restake estimation */
export interface ValidatorStakeInfo {
    poolStake: number;
    pendingStake: number;
    pendingWithdraw: number;
    commission: number; // percentage, e.g. 5 means 5%
    perEpochYield: number;
}

// ── Epoch yield computation ─────────────────────────────────────────

/**
 * Compute per-epoch yields from exchange rate entries sorted ascending by epoch.
 * Exchange rates are recorded every epoch on-chain, so consecutive entries
 * should have epochGap=1. If there's a gap (shouldn't happen with full data),
 * we skip that pair rather than averaging across it.
 */
export function computeEpochYields(entries: EpochRateEntry[]): EpochYieldEntry[] {
    if (entries.length < 2) return [];

    const yields: EpochYieldEntry[] = [];
    for (let i = 1; i < entries.length; i++) {
        const prev = entries[i - 1];
        const curr = entries[i];
        const epochGap = curr.epoch - prev.epoch;

        if (epochGap !== 1 || prev.rate <= 0) continue;

        const perEpochYield = (curr.rate - prev.rate) / prev.rate;

        yields.push({
            epoch: curr.epoch,
            perEpochYield,
            annualizedApy: perEpochYield * 365 * 100,
        });
    }
    return yields;
}

// ── Average APY ─────────────────────────────────────────────────────

/**
 * Simple arithmetic average of the most recent `count` epoch yields, annualized.
 * Returns 0 if no yields are available.
 */
export function computeAverageApy(
    yields: EpochYieldEntry[],
    count: number,
): number {
    if (yields.length === 0 || count <= 0) return 0;

    const n = Math.min(count, yields.length);
    let sum = 0;
    for (let i = yields.length - n; i < yields.length; i++) {
        sum += yields[i].perEpochYield;
    }
    return (sum / n) * 365 * 100;
}

// ── Anomaly detection ───────────────────────────────────────────────

/**
 * Detect if the latest APY is anomalous relative to a baseline average.
 * Anomalous = latest exceeds 2x the average, OR absolute deviation > 2pp
 * when the average is very small.
 */
export function detectAnomaly(
    latestApy: number,
    avgApy: number,
): { isAnomalous: boolean; factor: number } {
    if (avgApy <= 0) {
        return {
            isAnomalous: latestApy > 0,
            factor: latestApy > 0 ? Infinity : 1,
        };
    }
    const factor = latestApy / avgApy;
    const isAnomalous = factor > 2 || (latestApy - avgApy) > 2;
    return { isAnomalous, factor };
}

// ── Orchestrator ────────────────────────────────────────────────────

/**
 * Compute full APY history from sorted (ascending) exchange rate entries.
 */
export function computeValidatorApyHistory(
    entries: EpochRateEntry[],
): ValidatorApyHistory {
    const epochYields = computeEpochYields(entries);

    if (epochYields.length === 0) {
        return {
            epochYields: [],
            latestApy: 0,
            avg7Apy: 0,
            avg30Apy: 0,
            perEpochYield: 0,
            isAnomalous: false,
            anomalyFactor: 1,
        };
    }

    const latestApy = epochYields[epochYields.length - 1].annualizedApy;
    const avg7Apy = computeAverageApy(epochYields, 7);
    const avg30Apy = computeAverageApy(epochYields, 30);
    const { isAnomalous, factor: anomalyFactor } = detectAnomaly(latestApy, avg30Apy);

    const perEpochYield = avg7Apy / (365 * 100);

    return {
        epochYields,
        latestApy: Math.max(0, latestApy),
        avg7Apy: Math.max(0, avg7Apy),
        avg30Apy: Math.max(0, avg30Apy),
        perEpochYield: Math.max(0, perEpochYield),
        isAnomalous,
        anomalyFactor,
    };
}

// ── Restake yield estimation ─────────────────────────────────────────

/** Next-epoch effective stake: current pool + pending incoming - pending withdrawals */
export function nextEpochStake(v: ValidatorStakeInfo): number {
    return v.poolStake + v.pendingStake - v.pendingWithdraw;
}

export function estimatePostRestakeYield(
    source: ValidatorStakeInfo | null,
    target: ValidatorStakeInfo,
    moveAmount: number,
    totalNetworkStake: number,
): { estSourceYield: number; estTargetYield: number; estTargetApy: number } {
    if (totalNetworkStake <= 0) {
        return {
            estSourceYield: source?.perEpochYield ?? 0,
            estTargetYield: target.perEpochYield,
            estTargetApy: target.perEpochYield * 365 * 100,
        };
    }

    const effectiveComm = (stake: number, commPct: number) =>
        Math.max(commPct, Math.min((stake / totalNetworkStake) * 100, 10));

    const srcStake = source ? nextEpochStake(source) : 0;
    const srcComm = source?.commission ?? 0;
    const tgtStake = nextEpochStake(target);
    const tgtComm = target.commission;

    const srcEffCommBefore = effectiveComm(srcStake, srcComm);
    const tgtEffCommBefore = effectiveComm(tgtStake, tgtComm);

    const srcEffCommAfter = effectiveComm(Math.max(0, srcStake - moveAmount), srcComm);
    const tgtEffCommAfter = effectiveComm(tgtStake + moveAmount, tgtComm);

    const scaleYield = (yield_: number, effBefore: number, effAfter: number) => {
        const factor = (1 - effBefore / 100);
        if (factor <= 0) return 0;
        return yield_ * (1 - effAfter / 100) / factor;
    };

    const estTargetYield = scaleYield(target.perEpochYield, tgtEffCommBefore, tgtEffCommAfter);

    return {
        estSourceYield: source
            ? scaleYield(source.perEpochYield, srcEffCommBefore, srcEffCommAfter)
            : 0,
        estTargetYield,
        estTargetApy: Math.max(0, estTargetYield * 365 * 100),
    };
}

// ── Break-even calculation ──────────────────────────────────────────

export function computeBreakEven(
    principalIota: number,
    currentYield: number,
    targetYield: number,
): { lostReward: number; savingsPerEpoch: number; breakEvenEpochs: number } {
    const lostReward = principalIota * currentYield;
    const savingsPerEpoch = principalIota * (targetYield - currentYield);
    const breakEvenEpochs =
        savingsPerEpoch > 0 ? Math.ceil(lostReward / savingsPerEpoch) : Infinity;
    return { lostReward, savingsPerEpoch, breakEvenEpochs };
}
