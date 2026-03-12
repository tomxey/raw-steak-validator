import type { EpochYieldEntry } from '../lib/apy';
import EpochYieldChart from './EpochYieldChart';
import { formatIota } from '../lib/utils';

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

interface ValidatorDetailProps {
    validator: ValidatorApyInfo;
    onClose: () => void;
}

export default function ValidatorDetail({ validator: v, onClose }: ValidatorDetailProps) {
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>{v.name}</h2>
                    <button className="modal-close" onClick={onClose}>x</button>
                </div>

                <div className="modal-body">
                    <div className="detail-grid">
                        <div className="detail-item">
                            <span className="label">Address</span>
                            <span className="value mono">
                                {v.address.slice(0, 10)}...{v.address.slice(-8)}
                            </span>
                        </div>
                        <div className="detail-item">
                            <span className="label">Commission</span>
                            <span className="value">{v.commission}%</span>
                        </div>
                    </div>

                    <div className="apy-summary">
                        <div className="apy-card">
                            <span className="apy-label">7-Day APY</span>
                            <span className="apy-value accent">
                                {v.avg7Apy > 0 ? `${v.avg7Apy.toFixed(2)}%` : '—'}
                            </span>
                        </div>
                        <div className="apy-card">
                            <span className="apy-label">30-Day APY</span>
                            <span className="apy-value">
                                {v.avg30Apy > 0 ? `${v.avg30Apy.toFixed(2)}%` : '—'}
                            </span>
                        </div>
                        <div className="apy-card">
                            <span className="apy-label">Latest Epoch</span>
                            <span className={`apy-value ${v.isAnomalous ? 'apy-anomalous' : ''}`}>
                                {v.latestApy > 0 ? `${v.latestApy.toFixed(2)}%` : '—'}
                                {v.isAnomalous && (
                                    <span className="anomaly-badge">
                                        {v.anomalyFactor === Infinity ? 'spike' : `${v.anomalyFactor.toFixed(1)}x`}
                                    </span>
                                )}
                            </span>
                        </div>
                    </div>

                    <h3>Reward per IOTA per Epoch</h3>
                    <EpochYieldChart
                        yields={v.epochYields}
                        avg7Apy={v.avg7Apy}
                        avg30Apy={v.avg30Apy}
                    />

                    <div className="detail-grid" style={{ marginTop: 16 }}>
                        <div className="detail-item">
                            <span className="label">Total Pool Stake</span>
                            <span className="value">
                                {formatIota(BigInt(Math.round(v.poolStake * 1e9)), 0)} IOTA
                            </span>
                        </div>
                        <div className="detail-item">
                            <span className="label">Pending Stake</span>
                            <span className="value">
                                {formatIota(BigInt(Math.round(v.pendingStake * 1e9)), 0)} IOTA
                            </span>
                        </div>
                        <div className="detail-item">
                            <span className="label">Pending Withdrawals</span>
                            <span className="value">
                                {formatIota(BigInt(Math.round(v.pendingWithdraw * 1e9)), 0)} IOTA
                            </span>
                        </div>
                        <div className="detail-item">
                            <span className="label">Epochs of Data</span>
                            <span className="value">{v.epochYields.length}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
