const ADMIN_HASHES: Set<string> = new Set(
    (import.meta.env.VITE_ADMIN_HASHES ?? '')
        .split(',')
        .map((h: string) => h.trim().toLowerCase())
        .filter(Boolean),
);

let hashCache: Map<string, string> = new Map();

async function sha256(message: string): Promise<string> {
    const cached = hashCache.get(message);
    if (cached) return cached;
    const data = new TextEncoder().encode(message);
    const buf = await crypto.subtle.digest('SHA-256', data);
    const hex = Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    hashCache.set(message, hex);
    return hex;
}

export async function isAdmin(address: string | undefined): Promise<boolean> {
    if (!address || ADMIN_HASHES.size === 0) return false;
    const hash = await sha256(address);
    return ADMIN_HASHES.has(hash);
}
