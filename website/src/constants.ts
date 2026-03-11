export const VALIDATOR_ADDRESS =
    '0xcc844157e77e16246cc73d171e8affa4c444c999c9afd3cebb0876df4a3d4360';

export const IOTA_DECIMALS = 9;
export const MIN_STAKE_IOTA = 1;
export const MIN_STAKE_NANOS = BigInt(MIN_STAKE_IOTA) * BigInt(10 ** IOTA_DECIMALS);
export const GAS_BUDGET_NANOS = BigInt(50_000_000); // 0.05 IOTA

// Candidate validator's inner Versioned object ID (for querying staking pool balance)
export const VALIDATOR_INNER_ID =
    '0x9dbbc4a6790a81997c81919940c382d450527285bf715b847d227d8de77e73b7';
