export const VALIDATOR_ADDRESS =
    '0xcc844157e77e16246cc73d171e8affa4c444c999c9afd3cebb0876df4a3d4360';

export const IOTA_DECIMALS = 9;
export const MIN_STAKE_IOTA = 1;
export const MIN_STAKE_NANOS = BigInt(MIN_STAKE_IOTA) * BigInt(10 ** IOTA_DECIMALS);
export const GAS_BUDGET_NANOS = BigInt(50_000_000); // 0.05 IOTA

// Candidate validator's inner Versioned object ID (for querying staking pool balance)
export const VALIDATOR_INNER_ID =
    '0x9dbbc4a6790a81997c81919940c382d450527285bf715b847d227d8de77e73b7';

// LSP (Liquid Staking Pool) constants
export const LSP_ORIGINAL_PACKAGE_ID = '0x33bb7e4d03df9224a5c1d5fcd7260f2940de81f6a8f40fcd9e2b7917fb15abd5';
export const LSP_PACKAGE_ID = '0xb2664e27105a7df0b607ff306bba72835835884b225b4584fafe7464907accf3'; // v2
export const LSP_POOL_ID = '0xd789379a9fc8c6f220f4810a64341191a3fab751aa4da8928889cd84264bfafe';
export const LSP_POOL_INITIAL_SHARED_VERSION = 483851920;
export const RIOTA_COIN_TYPE = `${LSP_ORIGINAL_PACKAGE_ID}::riota::RIOTA`;
