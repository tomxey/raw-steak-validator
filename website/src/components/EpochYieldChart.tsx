import { useState } from 'react';
import type { EpochYieldEntry } from '../lib/apy';

interface EpochYieldChartProps {
    yields: EpochYieldEntry[];
    avg7Apy: number;
    avg30Apy: number;
    width?: number;
    height?: number;
}

export default function EpochYieldChart({
    yields,
    avg7Apy,
    avg30Apy,
    width = 600,
    height = 200,
}: EpochYieldChartProps) {
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

    if (yields.length === 0) {
        return <div className="chart-empty">No epoch yield data available</div>;
    }

    // Convert yields to reward per 10,000 IOTA staked
    const rewardPer10k = yields.map((y) => y.perEpochYield * 10_000);
    const maxReward = Math.max(...rewardPer10k, 0);
    const minReward = Math.min(...rewardPer10k, 0);

    // Avg lines in per-10k-IOTA units
    const avg7Yield = avg7Apy / (365 * 100) * 10_000;
    const avg30Yield = avg30Apy / (365 * 100) * 10_000;

    const padding = { top: 20, right: 20, bottom: 30, left: 60 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    // Y scale: from 0 (or minReward if negative) to maxReward with 10% headroom
    const yMin = Math.min(0, minReward);
    const yMax = maxReward * 1.1 || 0.0001; // avoid zero range
    const yScale = (v: number) => chartH - ((v - yMin) / (yMax - yMin)) * chartH;

    // Bar layout
    const barGap = 1;
    const barWidth = Math.max(2, (chartW - barGap * (yields.length - 1)) / yields.length);

    // Y-axis ticks
    const tickCount = 4;
    const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => {
        const val = yMin + (yMax - yMin) * (i / tickCount);
        return val;
    });

    // Anomaly threshold: 2x avg30
    const anomalyThreshold = avg30Yield * 2;

    return (
        <div className="epoch-yield-chart">
            <svg
                viewBox={`0 0 ${width} ${height}`}
                width="100%"
                preserveAspectRatio="xMidYMid meet"
            >
                {/* Y-axis labels and grid lines */}
                {yTicks.map((tick) => {
                    const y = padding.top + yScale(tick);
                    return (
                        <g key={tick}>
                            <line
                                x1={padding.left}
                                y1={y}
                                x2={width - padding.right}
                                y2={y}
                                stroke="var(--border)"
                                strokeWidth={0.5}
                                strokeDasharray="4,4"
                            />
                            <text
                                x={padding.left - 6}
                                y={y + 3}
                                textAnchor="end"
                                fontSize={9}
                                fill="var(--text-secondary)"
                            >
                                {formatRewardLabel(tick)}
                            </text>
                        </g>
                    );
                })}

                {/* Average reference lines */}
                <line
                    x1={padding.left}
                    y1={padding.top + yScale(avg7Yield)}
                    x2={width - padding.right}
                    y2={padding.top + yScale(avg7Yield)}
                    stroke="var(--accent)"
                    strokeWidth={1.5}
                    strokeDasharray="6,3"
                />
                <text
                    x={width - padding.right + 2}
                    y={padding.top + yScale(avg7Yield) - 3}
                    fontSize={8}
                    fill="var(--accent)"
                >
                    7d
                </text>

                <line
                    x1={padding.left}
                    y1={padding.top + yScale(avg30Yield)}
                    x2={width - padding.right}
                    y2={padding.top + yScale(avg30Yield)}
                    stroke="var(--text-secondary)"
                    strokeWidth={1}
                    strokeDasharray="3,3"
                />
                <text
                    x={width - padding.right + 2}
                    y={padding.top + yScale(avg30Yield) - 3}
                    fontSize={8}
                    fill="var(--text-secondary)"
                >
                    30d
                </text>

                {/* Bars */}
                {yields.map((y, i) => {
                    const x = padding.left + i * (barWidth + barGap);
                    const reward = rewardPer10k[i];
                    const barH = Math.abs(yScale(0) - yScale(reward));
                    const barY = reward >= 0
                        ? padding.top + yScale(reward)
                        : padding.top + yScale(0);
                    const isAnomaly = reward > anomalyThreshold;
                    const isHovered = hoveredIndex === i;

                    return (
                        <g
                            key={y.epoch}
                            onMouseEnter={() => setHoveredIndex(i)}
                            onMouseLeave={() => setHoveredIndex(null)}
                        >
                            <rect
                                x={x}
                                y={barY}
                                width={barWidth}
                                height={Math.max(1, barH)}
                                fill={isAnomaly ? 'var(--warning)' : 'var(--accent)'}
                                opacity={isHovered ? 1 : 0.7}
                                rx={1}
                            />
                            {/* Hit area for narrow bars */}
                            <rect
                                x={x}
                                y={padding.top}
                                width={barWidth}
                                height={chartH}
                                fill="transparent"
                            />
                        </g>
                    );
                })}

                {/* X-axis labels (show every Nth epoch to avoid crowding) */}
                {yields.map((y, i) => {
                    const showLabel = yields.length <= 15 || i % Math.ceil(yields.length / 10) === 0 || i === yields.length - 1;
                    if (!showLabel) return null;
                    const x = padding.left + i * (barWidth + barGap) + barWidth / 2;
                    return (
                        <text
                            key={y.epoch}
                            x={x}
                            y={height - 6}
                            textAnchor="middle"
                            fontSize={8}
                            fill="var(--text-secondary)"
                        >
                            {y.epoch}
                        </text>
                    );
                })}

                {/* X-axis label */}
                <text
                    x={padding.left + chartW / 2}
                    y={height - 1}
                    textAnchor="middle"
                    fontSize={9}
                    fill="var(--text-secondary)"
                >
                    Epoch
                </text>
            </svg>

            {/* Tooltip */}
            {hoveredIndex !== null && (
                <div className="chart-tooltip">
                    <strong>Epoch {yields[hoveredIndex].epoch}</strong>
                    <br />
                    Reward per 10k IOTA: {rewardPer10k[hoveredIndex].toFixed(2)} IOTA
                    <br />
                    APY: {yields[hoveredIndex].annualizedApy.toFixed(2)}%
                </div>
            )}
        </div>
    );
}

function formatRewardLabel(value: number): string {
    if (value === 0) return '0';
    if (Math.abs(value) >= 1) return value.toFixed(1);
    return value.toFixed(2);
}
