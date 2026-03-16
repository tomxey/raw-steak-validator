# rIOTA LSP — Liquid Staking Pool

Move smart contract for the Raw Steak liquid staking protocol on IOTA.

## Deployed Addresses

### Mainnet

| Object | ID |
|---|---|
| Package | `0x33bb7e4d03df9224a5c1d5fcd7260f2940de81f6a8f40fcd9e2b7917fb15abd5` |
| Pool (shared) | `0xd789379a9fc8c6f220f4810a64341191a3fab751aa4da8928889cd84264bfafe` |
| AdminCap | `0x1f69b9c2c7df72c927ce6b45087498496f68a5297869dec17748bfc812462764` |
| CoinMetadata | `0x7fb0f5d94c69d21e87184297ff39c39432b56ee1ee94b8f50d2e124228dd2df6` |
| UpgradeCap | `0x9945524f4c0d15e22f6098f12a56428f75d76d186add9077939a9b6940213734` |

### Devnet

| Object | ID |
|---|---|
| Package | `0x2f94f5ebe0c25371670d17fc0d2763117e60372538ae52c83729a094c8b6e4e3` |
| Pool (shared) | `0x1dde573ed99d837d7b63c84028a260a95aed5ced9271c7b4b1bc1b59a586a9ba` |
| AdminCap | `0x4a0768ff84e112fedfc3a8f3347ff88392bef444bb1391ba9a1f4d8c25b523f3` |

## Build & Test

```bash
cd contracts/riota_lsp
iota move build
iota move test
```
