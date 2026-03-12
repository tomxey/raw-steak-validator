# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

IOTA Mainnet validator staking dApp for "Raw Steak" validator (raw-steak.eu). A React SPA that lets users stake/unstake IOTA tokens and optimize their staking across validators using on-chain APY data.

## Commands

```bash
# Development (run from website/)
cd website && npm install
cd website && npm run dev          # Vite dev server
cd website && npm run build        # TypeScript check + Vite production build

# Deploy (from repo root, requires Docker on the server)
bash scripts/deploy.sh
```

No test runner or linter is configured.

## Architecture

- **website/** — Single React+Vite+TypeScript app (no backend)
- **docker/** — Multi-stage Docker build (node build → Caddy serve) with docker-compose
- **scripts/** — `deploy.sh` runs `docker compose up --build -d` from docker/

### Key Libraries

- `@iota/dapp-kit` — Wallet connection, IOTA client hooks (`useIotaClientQuery`, `useIotaClient`, `useSignAndExecuteTransaction`)
- `@iota/iota-sdk` — Transaction building (`Transaction`), system object IDs
- `@tanstack/react-query` — Data fetching/caching layer
- `react-router-dom` — Client-side routing (BrowserRouter)

### App Structure

- [main.tsx](website/src/main.tsx) — Provider stack: QueryClient → IotaClientProvider (mainnet) → WalletProvider → BrowserRouter
- [App.tsx](website/src/App.tsx) — Routes (`/` = stake/unstake, `/optimize` = optimizer). Contains `ValidatorInfo`, `StakeForm`, `MyStakes` components inline.
- [OptimizerPage.tsx](website/src/OptimizerPage.tsx) — Computes APY from on-chain exchange rates for all validators, suggests restaking to higher-APY validators with break-even calculations.
- [lib/transactions.ts](website/src/lib/transactions.ts) — Transaction builders: `createStakeTransaction`, `createUnstakeTransaction`, `createRestakeTransaction` (atomic unstake+restake via Move calls)
- [lib/utils.ts](website/src/lib/utils.ts) — `formatIota` (nanos→human), `waitAndCheckTx` (poll tx status)
- [constants.ts](website/src/constants.ts) — Validator address, inner ID, min stake, gas budget
- [networkConfig.ts](website/src/networkConfig.ts) — IOTA mainnet RPC config

### IOTA-Specific Patterns

- All amounts are in **nanos** (1 IOTA = 10^9 nanos), use `BigInt` throughout
- Transactions use Move calls to `0x3::iota_system::*` with `IOTA_SYSTEM_STATE_OBJECT_ID` as shared object ref
- APY is computed from validator exchange rate history (dynamic fields on `exchangeRatesId`), not from commission alone
- The validator may be in "candidate" status (not yet in active set); the app handles both states
