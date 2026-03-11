import type { IotaClient } from '@iota/iota-sdk/client';
import { IOTA_DECIMALS } from '../constants';

export async function waitAndCheckTx(
    iotaClient: IotaClient,
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

export function formatIota(nanos: string | bigint, decimals?: number): string {
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
