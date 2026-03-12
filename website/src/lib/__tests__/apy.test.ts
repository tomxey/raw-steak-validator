import { describe, it, expect } from 'vitest';
import {
    computeEpochYields,
    computeAverageApy,
    computeValidatorApyHistory,
    detectAnomaly,
    computeBreakEven,
    estimatePostRestakeYield,
    nextEpochStake,
    type EpochRateEntry,
    type EpochYieldEntry,
    type ValidatorStakeInfo,
} from '../apy';

// ── Helpers ─────────────────────────────────────────────────────────

/** Build a series of rate entries with steady per-epoch growth */
function steadyGrowthEntries(
    startEpoch: number,
    count: number,
    baseRate: number,
    perEpochYield: number,
): EpochRateEntry[] {
    const entries: EpochRateEntry[] = [];
    let rate = baseRate;
    for (let i = 0; i < count; i++) {
        entries.push({
            epoch: startEpoch + i,
            iotaAmount: rate * 1e9,
            poolTokenAmount: 1e9,
            rate,
        });
        rate *= (1 + perEpochYield);
    }
    return entries;
}

// ── computeEpochYields ──────────────────────────────────────────────

describe('computeEpochYields', () => {
    it('returns empty array for fewer than 2 entries', () => {
        expect(computeEpochYields([])).toEqual([]);
        expect(computeEpochYields([{ epoch: 1, iotaAmount: 1e9, poolTokenAmount: 1e9, rate: 1.0 }])).toEqual([]);
    });

    it('computes yield from two consecutive entries', () => {
        const entries: EpochRateEntry[] = [
            { epoch: 10, iotaAmount: 1e9, poolTokenAmount: 1e9, rate: 1.0 },
            { epoch: 11, iotaAmount: 1.0001e9, poolTokenAmount: 1e9, rate: 1.0001 },
        ];
        const yields = computeEpochYields(entries);
        expect(yields).toHaveLength(1);
        expect(yields[0].epoch).toBe(11);
        expect(yields[0].epochGap).toBe(1);
        expect(yields[0].perEpochYield).toBeCloseTo(0.0001, 8);
        expect(yields[0].annualizedApy).toBeCloseTo(0.0001 * 365 * 100, 4);
    });

    it('computes steady growth over 5 consecutive epochs', () => {
        const perEpochYield = 0.0001; // ~3.65% APY
        const entries = steadyGrowthEntries(100, 5, 1.0, perEpochYield);
        const yields = computeEpochYields(entries);

        expect(yields).toHaveLength(4);
        for (const y of yields) {
            expect(y.epochGap).toBe(1);
            expect(y.perEpochYield).toBeCloseTo(perEpochYield, 8);
        }
    });

    it('handles large withdrawal spike (Figment scenario)', () => {
        // 5 steady epochs, then a massive spike in epoch 6
        const perEpochYield = 0.0001;
        const entries = steadyGrowthEntries(100, 5, 1.0, perEpochYield);

        // Epoch 105: rate jumps 10x normal yield (simulating withdrawal redistribution)
        const lastRate = entries[entries.length - 1].rate;
        const spikeRate = lastRate * (1 + perEpochYield * 10);
        entries.push({
            epoch: 105,
            iotaAmount: spikeRate * 1e9,
            poolTokenAmount: 1e9,
            rate: spikeRate,
        });

        const yields = computeEpochYields(entries);
        expect(yields).toHaveLength(5);

        // First 4 should be steady
        for (let i = 0; i < 4; i++) {
            expect(yields[i].perEpochYield).toBeCloseTo(perEpochYield, 7);
        }
        // Last one should be ~10x the normal
        expect(yields[4].perEpochYield).toBeCloseTo(perEpochYield * 10, 6);
    });

    it('normalizes yield by epoch gap for non-consecutive epochs', () => {
        const entries: EpochRateEntry[] = [
            { epoch: 10, iotaAmount: 1e9, poolTokenAmount: 1e9, rate: 1.0 },
            { epoch: 13, iotaAmount: 1.0003e9, poolTokenAmount: 1e9, rate: 1.0003 },
        ];
        const yields = computeEpochYields(entries);
        expect(yields).toHaveLength(1);
        expect(yields[0].epochGap).toBe(3);
        // Total yield = 0.0003, per epoch = 0.0001
        expect(yields[0].perEpochYield).toBeCloseTo(0.0003 / 3, 8);
    });

    it('skips entries with zero or negative epoch gap', () => {
        const entries: EpochRateEntry[] = [
            { epoch: 10, iotaAmount: 1e9, poolTokenAmount: 1e9, rate: 1.0 },
            { epoch: 10, iotaAmount: 1.0001e9, poolTokenAmount: 1e9, rate: 1.0001 }, // same epoch
            { epoch: 11, iotaAmount: 1.0002e9, poolTokenAmount: 1e9, rate: 1.0002 },
        ];
        const yields = computeEpochYields(entries);
        // First pair skipped (gap=0), second pair uses rate from epoch 10 entry
        expect(yields.length).toBeGreaterThanOrEqual(1);
        expect(yields.every(y => y.epochGap > 0)).toBe(true);
    });

    it('skips entries where previous rate is zero', () => {
        const entries: EpochRateEntry[] = [
            { epoch: 10, iotaAmount: 0, poolTokenAmount: 1e9, rate: 0 },
            { epoch: 11, iotaAmount: 1e9, poolTokenAmount: 1e9, rate: 1.0 },
        ];
        const yields = computeEpochYields(entries);
        expect(yields).toHaveLength(0);
    });

    it('handles negative rate changes (declining validator)', () => {
        const entries: EpochRateEntry[] = [
            { epoch: 10, iotaAmount: 1.001e9, poolTokenAmount: 1e9, rate: 1.001 },
            { epoch: 11, iotaAmount: 1e9, poolTokenAmount: 1e9, rate: 1.0 },
        ];
        const yields = computeEpochYields(entries);
        expect(yields).toHaveLength(1);
        expect(yields[0].perEpochYield).toBeLessThan(0);
    });

    it('handles identical rates across epochs (zero yield)', () => {
        const entries: EpochRateEntry[] = [
            { epoch: 10, iotaAmount: 1e9, poolTokenAmount: 1e9, rate: 1.0 },
            { epoch: 11, iotaAmount: 1e9, poolTokenAmount: 1e9, rate: 1.0 },
            { epoch: 12, iotaAmount: 1e9, poolTokenAmount: 1e9, rate: 1.0 },
        ];
        const yields = computeEpochYields(entries);
        expect(yields).toHaveLength(2);
        for (const y of yields) {
            expect(y.perEpochYield).toBe(0);
            expect(y.annualizedApy).toBe(0);
        }
    });
});

// ── computeAverageApy ───────────────────────────────────────────────

describe('computeAverageApy', () => {
    it('returns 0 for empty yields', () => {
        expect(computeAverageApy([], 7)).toBe(0);
    });

    it('returns 0 for zero window', () => {
        const yields: EpochYieldEntry[] = [
            { epoch: 11, epochGap: 1, perEpochYield: 0.0001, annualizedApy: 3.65 },
        ];
        expect(computeAverageApy(yields, 0)).toBe(0);
    });

    it('returns correct APY for uniform yields', () => {
        const perEpochYield = 0.0001;
        const yields: EpochYieldEntry[] = Array.from({ length: 10 }, (_, i) => ({
            epoch: 101 + i,
            epochGap: 1,
            perEpochYield,
            annualizedApy: perEpochYield * 365 * 100,
        }));

        const avg7 = computeAverageApy(yields, 7);
        expect(avg7).toBeCloseTo(perEpochYield * 365 * 100, 6);
    });

    it('one spike among steady epochs has limited effect on average', () => {
        const steady = 0.0001;
        const spike = 0.001; // 10x

        const yields: EpochYieldEntry[] = Array.from({ length: 10 }, (_, i) => ({
            epoch: 101 + i,
            epochGap: 1,
            perEpochYield: i === 9 ? spike : steady, // spike only in last epoch
            annualizedApy: (i === 9 ? spike : steady) * 365 * 100,
        }));

        const avg7 = computeAverageApy(yields, 7);
        const avg30 = computeAverageApy(yields, 30);
        const latestApy = spike * 365 * 100;

        // avg7 includes 1 spike + 6 steady = (0.001 + 6*0.0001) / 7
        const expected7 = ((spike + 6 * steady) / 7) * 365 * 100;
        expect(avg7).toBeCloseTo(expected7, 4);

        // avg30 uses all 10 entries (only 10 available)
        const expected30 = ((spike + 9 * steady) / 10) * 365 * 100;
        expect(avg30).toBeCloseTo(expected30, 4);

        // Both averages much lower than spike
        expect(avg7).toBeLessThan(latestApy);
        expect(avg30).toBeLessThan(avg7);
    });

    it('uses all available data when window exceeds data length', () => {
        const perEpochYield = 0.0001;
        const yields: EpochYieldEntry[] = [
            { epoch: 101, epochGap: 1, perEpochYield, annualizedApy: perEpochYield * 365 * 100 },
            { epoch: 102, epochGap: 1, perEpochYield, annualizedApy: perEpochYield * 365 * 100 },
        ];

        const avg30 = computeAverageApy(yields, 30);
        expect(avg30).toBeCloseTo(perEpochYield * 365 * 100, 6);
    });

    it('window of 1 equals latest', () => {
        const yields: EpochYieldEntry[] = [
            { epoch: 101, epochGap: 1, perEpochYield: 0.0001, annualizedApy: 3.65 },
            { epoch: 102, epochGap: 1, perEpochYield: 0.0002, annualizedApy: 7.30 },
        ];

        const avg1 = computeAverageApy(yields, 1);
        expect(avg1).toBeCloseTo(0.0002 * 365 * 100, 6);
    });

    it('correctly weights non-uniform epoch gaps', () => {
        // Entry covering 3 epochs at yield 0.0001, then entry covering 1 epoch at 0.0003
        const yields: EpochYieldEntry[] = [
            { epoch: 103, epochGap: 3, perEpochYield: 0.0001, annualizedApy: 3.65 },
            { epoch: 104, epochGap: 1, perEpochYield: 0.0003, annualizedApy: 10.95 },
        ];

        // Window of 4: weighted = (0.0003*1 + 0.0001*3) / 4 = 0.0006/4 = 0.00015
        const avg4 = computeAverageApy(yields, 4);
        expect(avg4).toBeCloseTo(0.00015 * 365 * 100, 4);

        // Window of 2: uses 1 epoch of the second entry + 1 epoch of the first
        // weighted = (0.0003*1 + 0.0001*1) / 2 = 0.0002
        const avg2 = computeAverageApy(yields, 2);
        expect(avg2).toBeCloseTo(0.0002 * 365 * 100, 4);
    });

    it('clamps epoch gap contribution to window boundary', () => {
        // One entry spanning 10 epochs, window is 3
        const yields: EpochYieldEntry[] = [
            { epoch: 110, epochGap: 10, perEpochYield: 0.0002, annualizedApy: 7.30 },
        ];

        const avg3 = computeAverageApy(yields, 3);
        // Should use only 3 epochs worth: (0.0002 * 3) / 3 = 0.0002
        expect(avg3).toBeCloseTo(0.0002 * 365 * 100, 6);
    });
});

// ── detectAnomaly ───────────────────────────────────────────────────

describe('detectAnomaly', () => {
    it('flags when latest is 3x the average', () => {
        const result = detectAnomaly(9.0, 3.0);
        expect(result.isAnomalous).toBe(true);
        expect(result.factor).toBeCloseTo(3.0, 6);
    });

    it('does not flag when latest is 1.5x the average', () => {
        const result = detectAnomaly(4.5, 3.0);
        expect(result.isAnomalous).toBe(false);
        expect(result.factor).toBeCloseTo(1.5, 6);
    });

    it('flags when latest is exactly 2x + epsilon', () => {
        const result = detectAnomaly(6.01, 3.0);
        expect(result.isAnomalous).toBe(true);
    });

    it('flags at exactly 2x when absolute deviation exceeds 2pp', () => {
        // 6.0 vs 3.0: factor=2 (not >2), but absolute diff=3pp > 2pp → anomalous
        const result = detectAnomaly(6.0, 3.0);
        expect(result.isAnomalous).toBe(true);
    });

    it('does not flag at 1.9x with small absolute deviation', () => {
        // 1.9 vs 1.0: factor=1.9 (<2), absolute diff=0.9pp (<2) → not anomalous
        const result = detectAnomaly(1.9, 1.0);
        expect(result.isAnomalous).toBe(false);
    });

    it('flags when absolute deviation exceeds 2pp', () => {
        // 1.5x but >2pp absolute difference
        const result = detectAnomaly(5.1, 3.0);
        expect(result.isAnomalous).toBe(true);
    });

    it('handles zero average with positive latest', () => {
        const result = detectAnomaly(3.0, 0);
        expect(result.isAnomalous).toBe(true);
        expect(result.factor).toBe(Infinity);
    });

    it('handles both zero', () => {
        const result = detectAnomaly(0, 0);
        expect(result.isAnomalous).toBe(false);
    });

    it('handles negative latest gracefully', () => {
        const result = detectAnomaly(-1.0, 3.0);
        expect(result.isAnomalous).toBe(false);
    });
});

// ── computeValidatorApyHistory (integration) ────────────────────────

describe('computeValidatorApyHistory', () => {
    it('returns zeros for insufficient data', () => {
        const result = computeValidatorApyHistory([]);
        expect(result.epochYields).toHaveLength(0);
        expect(result.latestApy).toBe(0);
        expect(result.avg7Apy).toBe(0);
        expect(result.avg30Apy).toBe(0);
        expect(result.isAnomalous).toBe(false);
    });

    it('returns zeros for single entry', () => {
        const result = computeValidatorApyHistory([
            { epoch: 100, iotaAmount: 1e9, poolTokenAmount: 1e9, rate: 1.0 },
        ]);
        expect(result.epochYields).toHaveLength(0);
        expect(result.latestApy).toBe(0);
    });

    it('computes correct values for consistently high validator', () => {
        const perEpochYield = 0.00015; // ~5.475% APY
        const entries = steadyGrowthEntries(100, 31, 1.0, perEpochYield);
        const result = computeValidatorApyHistory(entries);

        const expectedApy = perEpochYield * 365 * 100;
        expect(result.latestApy).toBeCloseTo(expectedApy, 2);
        expect(result.avg7Apy).toBeCloseTo(expectedApy, 2);
        expect(result.avg30Apy).toBeCloseTo(expectedApy, 2);
        expect(result.isAnomalous).toBe(false);
        expect(result.epochYields).toHaveLength(30);
    });

    it('Figment scenario: 29 steady epochs + 1 massive spike', () => {
        const steadyYield = 0.0001; // ~3.65% APY
        const entries = steadyGrowthEntries(100, 30, 1.0, steadyYield);

        // Add epoch 130 with a 50x spike (simulating large withdrawal redistribution)
        const lastRate = entries[entries.length - 1].rate;
        const spikeRate = lastRate * (1 + steadyYield * 50);
        entries.push({
            epoch: 130,
            iotaAmount: spikeRate * 1e9,
            poolTokenAmount: 1e9,
            rate: spikeRate,
        });

        const result = computeValidatorApyHistory(entries);

        const spikeApy = (steadyYield * 50) * 365 * 100;

        // Latest APY should reflect the spike
        expect(result.latestApy).toBeCloseTo(spikeApy, 0);

        // 7-day avg: 1 spike epoch + 6 steady epochs
        // weighted avg yield = (steadyYield*50 * 1 + steadyYield * 6) / 7
        const expected7Yield = (steadyYield * 50 + steadyYield * 6) / 7;
        expect(result.avg7Apy).toBeCloseTo(expected7Yield * 365 * 100, 0);

        // 30-day avg: 1 spike + 29 steady
        const expected30Yield = (steadyYield * 50 + steadyYield * 29) / 30;
        expect(result.avg30Apy).toBeCloseTo(expected30Yield * 365 * 100, 0);

        // Should be flagged as anomalous
        expect(result.isAnomalous).toBe(true);
        expect(result.anomalyFactor).toBeGreaterThan(2);

        // avg7 is much lower than latest
        expect(result.avg7Apy).toBeLessThan(result.latestApy);
        // avg30 is even lower
        expect(result.avg30Apy).toBeLessThan(result.avg7Apy);
    });

    it('handles sparse data (< 7 entries) gracefully', () => {
        const perEpochYield = 0.0001;
        const entries = steadyGrowthEntries(100, 4, 1.0, perEpochYield);
        const result = computeValidatorApyHistory(entries);

        expect(result.epochYields).toHaveLength(3);
        // avg7 and avg30 should use all available data
        expect(result.avg7Apy).toBeCloseTo(perEpochYield * 365 * 100, 4);
        expect(result.avg30Apy).toBeCloseTo(perEpochYield * 365 * 100, 4);
    });

    it('handles epochs with gaps (validator offline)', () => {
        const entries: EpochRateEntry[] = [
            { epoch: 100, iotaAmount: 1e9, poolTokenAmount: 1e9, rate: 1.0 },
            { epoch: 105, iotaAmount: 1.0005e9, poolTokenAmount: 1e9, rate: 1.0005 }, // 5 epoch gap
            { epoch: 106, iotaAmount: 1.0006e9, poolTokenAmount: 1e9, rate: 1.0006 },
        ];
        const result = computeValidatorApyHistory(entries);
        expect(result.epochYields).toHaveLength(2);
        // First yield: 0.0005 over 5 epochs = 0.0001/epoch
        expect(result.epochYields[0].perEpochYield).toBeCloseTo(0.0001, 6);
        // Second yield: 0.0001 over 1 epoch
        expect(result.epochYields[1].perEpochYield).toBeCloseTo(0.0001, 4);
    });

    it('clamps negative APYs to zero', () => {
        const entries: EpochRateEntry[] = [
            { epoch: 100, iotaAmount: 1.001e9, poolTokenAmount: 1e9, rate: 1.001 },
            { epoch: 101, iotaAmount: 1e9, poolTokenAmount: 1e9, rate: 1.0 },
        ];
        const result = computeValidatorApyHistory(entries);
        expect(result.latestApy).toBe(0);
        expect(result.avg7Apy).toBe(0);
        expect(result.avg30Apy).toBe(0);
        expect(result.perEpochYield).toBe(0);
    });
});

// ── computeBreakEven ────────────────────────────────────────────────

describe('computeBreakEven', () => {
    it('computes finite break-even when target yield is higher', () => {
        const result = computeBreakEven(1000, 0.0001, 0.0002);
        // Lost reward: 1000 * 0.0001 = 0.1
        expect(result.lostReward).toBeCloseTo(0.1, 6);
        // Savings per epoch: 1000 * (0.0002 - 0.0001) = 0.1
        expect(result.savingsPerEpoch).toBeCloseTo(0.1, 6);
        // Break-even: ceil(0.1 / 0.1) = 1 epoch
        expect(result.breakEvenEpochs).toBe(1);
    });

    it('returns Infinity when target yield equals current', () => {
        const result = computeBreakEven(1000, 0.0001, 0.0001);
        expect(result.breakEvenEpochs).toBe(Infinity);
    });

    it('returns Infinity when target yield is lower', () => {
        const result = computeBreakEven(1000, 0.0002, 0.0001);
        expect(result.breakEvenEpochs).toBe(Infinity);
    });

    it('handles zero current yield (no lost reward)', () => {
        const result = computeBreakEven(1000, 0, 0.0001);
        expect(result.lostReward).toBe(0);
        expect(result.savingsPerEpoch).toBeCloseTo(0.1, 6);
        // ceil(0 / 0.1) = 0
        expect(result.breakEvenEpochs).toBe(0);
    });

    it('handles zero principal', () => {
        const result = computeBreakEven(0, 0.0001, 0.0002);
        expect(result.lostReward).toBe(0);
        expect(result.savingsPerEpoch).toBe(0);
        expect(result.breakEvenEpochs).toBe(Infinity);
    });

    it('rounds up break-even to nearest epoch', () => {
        // 1000 * 0.0001 = 0.1 lost, 1000 * 0.00003 = 0.03 savings
        // 0.1 / 0.03 = 3.33 → ceil = 4
        const result = computeBreakEven(1000, 0.0001, 0.00013);
        expect(result.breakEvenEpochs).toBe(4);
    });
});

// ── nextEpochStake ──────────────────────────────────────────────────

describe('nextEpochStake', () => {
    it('computes pool + pending - withdrawals', () => {
        const v: ValidatorStakeInfo = {
            poolStake: 1000000,
            pendingStake: 50000,
            pendingWithdraw: 20000,
            commission: 5,
            perEpochYield: 0.0001,
        };
        expect(nextEpochStake(v)).toBe(1030000);
    });

    it('handles zero pending values', () => {
        const v: ValidatorStakeInfo = {
            poolStake: 500000,
            pendingStake: 0,
            pendingWithdraw: 0,
            commission: 3,
            perEpochYield: 0.0001,
        };
        expect(nextEpochStake(v)).toBe(500000);
    });
});

// ── estimatePostRestakeYield ────────────────────────────────────────

describe('estimatePostRestakeYield', () => {
    const totalNetworkStake = 1_000_000_000; // 1B IOTA

    it('estimates yield change for normal restake', () => {
        const source: ValidatorStakeInfo = {
            poolStake: 10_000_000, // 1% of network
            pendingStake: 0,
            pendingWithdraw: 0,
            commission: 5,
            perEpochYield: 0.0001,
        };
        const target: ValidatorStakeInfo = {
            poolStake: 5_000_000, // 0.5% of network
            pendingStake: 0,
            pendingWithdraw: 0,
            commission: 3,
            perEpochYield: 0.00012,
        };

        const result = estimatePostRestakeYield(source, target, 100_000, totalNetworkStake);

        expect(result.estSourceYield).toBeGreaterThanOrEqual(0);
        expect(result.estTargetYield).toBeGreaterThan(0);
        expect(result.estTargetApy).toBeGreaterThan(0);
    });

    it('handles null source (new stake)', () => {
        const target: ValidatorStakeInfo = {
            poolStake: 5_000_000,
            pendingStake: 0,
            pendingWithdraw: 0,
            commission: 3,
            perEpochYield: 0.00012,
        };

        const result = estimatePostRestakeYield(null, target, 1000, totalNetworkStake);
        expect(result.estSourceYield).toBe(0);
        expect(result.estTargetYield).toBeGreaterThan(0);
    });

    it('handles zero total network stake gracefully', () => {
        const source: ValidatorStakeInfo = {
            poolStake: 1000,
            pendingStake: 0,
            pendingWithdraw: 0,
            commission: 5,
            perEpochYield: 0.0001,
        };
        const target: ValidatorStakeInfo = {
            poolStake: 2000,
            pendingStake: 0,
            pendingWithdraw: 0,
            commission: 3,
            perEpochYield: 0.00012,
        };

        const result = estimatePostRestakeYield(source, target, 100, 0);
        expect(result.estSourceYield).toBe(source.perEpochYield);
        expect(result.estTargetYield).toBe(target.perEpochYield);
    });

    it('accounts for pending operations in effective commission', () => {
        const target: ValidatorStakeInfo = {
            poolStake: 50_000_000, // 5%
            pendingStake: 10_000_000, // +1% pending
            pendingWithdraw: 0,
            commission: 3,
            perEpochYield: 0.00012,
        };

        // Moving 1M IOTA to a validator that already has 60M next-epoch stake
        const result = estimatePostRestakeYield(null, target, 1_000_000, totalNetworkStake);

        // The target's next-epoch stake is 60M (6%), adding 1M makes 61M
        // Effective comm = max(3%, 6.1%) = 6.1%, slightly higher than before (6%)
        // So yield should decrease slightly from the commission increase
        expect(result.estTargetYield).toBeLessThan(target.perEpochYield);
    });

    it('voting power cap at 10% limits effective commission', () => {
        const target: ValidatorStakeInfo = {
            poolStake: 150_000_000, // 15% of network — already capped at 10%
            pendingStake: 0,
            pendingWithdraw: 0,
            commission: 3,
            perEpochYield: 0.00008,
        };

        // Adding 10M shouldn't change anything since we're already at the cap
        const result = estimatePostRestakeYield(null, target, 10_000_000, totalNetworkStake);

        // Both before and after are capped at 10%, so yield should be unchanged
        expect(result.estTargetYield).toBeCloseTo(target.perEpochYield, 8);
    });
});

// ── Financial scenario tests ────────────────────────────────────────

describe('financial scenarios', () => {
    it('break-even with averaged vs single-epoch APY gives different advice', () => {
        // Scenario: validator A has steady 3.65% APY
        // Validator B had a spike making latest APY 20%, but avg7 is 5%
        const yieldA = 0.0001; // 3.65% APY steady
        const yieldB_latest = 20 / (365 * 100); // ~0.000548
        const yieldB_avg7 = 5 / (365 * 100); // ~0.000137

        const principal = 100_000; // 100K IOTA

        // Using latest APY: suggests moving from A to B
        const breakEvenLatest = computeBreakEven(principal, yieldA, yieldB_latest);
        expect(breakEvenLatest.breakEvenEpochs).toBeLessThan(Infinity);
        expect(breakEvenLatest.breakEvenEpochs).toBeLessThan(5); // Quick break-even

        // Using avg7 APY: still suggests moving but much longer break-even
        const breakEvenAvg7 = computeBreakEven(principal, yieldA, yieldB_avg7);
        expect(breakEvenAvg7.breakEvenEpochs).toBeLessThan(Infinity);
        expect(breakEvenAvg7.breakEvenEpochs).toBeGreaterThan(breakEvenLatest.breakEvenEpochs);
    });

    it('massive withdrawal makes single-epoch APY misleading', () => {
        // Real-world scenario: validator has 100M staked
        // 80M withdraws in one epoch, remaining 20M gets rewards meant for 100M
        // Exchange rate jumps ~5x normal
        const normalYield = 0.0001;
        const entries = steadyGrowthEntries(100, 30, 1.0, normalYield);

        const lastRate = entries[entries.length - 1].rate;
        entries.push({
            epoch: 130,
            iotaAmount: lastRate * (1 + normalYield * 5) * 1e9,
            poolTokenAmount: 1e9,
            rate: lastRate * (1 + normalYield * 5),
        });

        const history = computeValidatorApyHistory(entries);

        // Latest APY is 5x normal
        expect(history.latestApy).toBeCloseTo(normalYield * 5 * 365 * 100, 0);
        // But avg30 is close to normal
        const expected30 = ((normalYield * 5 + normalYield * 29) / 30) * 365 * 100;
        expect(history.avg30Apy).toBeCloseTo(expected30, 0);
        // And avg7 is moderately inflated
        expect(history.avg7Apy).toBeLessThan(history.latestApy);
        expect(history.avg7Apy).toBeGreaterThan(history.avg30Apy);
    });
});
