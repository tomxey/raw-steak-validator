# IOTA Staking Reward Mechanics

A detailed explanation of how staking rewards are calculated, distributed, and withdrawn on IOTA mainnet, based on the Move source code in `iota-framework/packages/iota-system/sources/`.

## 1. The Two Key Objects

### StakedIota (what the staker holds)

```
StakedIota {
    pool_id:                 <validator's staking pool ID>
    stake_activation_epoch:  E + 1    // stake requested at epoch E
    principal:               X IOTA   // never changes, even as rewards accrue
}
```

The principal is the staker's original deposit. It **never changes**. Rewards are not added to it — they are tracked implicitly through the pool's exchange rate.

### StakingPoolV1 (what the validator maintains)

```
StakingPoolV1 {
    iota_balance:                 u64    // total IOTA in pool (principals + rewards)
    pool_token_balance:           u64    // total virtual pool tokens issued
    rewards_pool:                 Balance // accumulated rewards (subset of iota_balance)
    pending_stake:                u64    // IOTA waiting to enter the pool
    pending_total_iota_withdraw:  u64    // IOTA waiting to leave the pool
    pending_pool_token_withdraw:  u64    // pool tokens to be burned
    exchange_rates:               Table<u64, {iota_amount, pool_token_amount}>
}
```

The exchange rate is:

```
rate = iota_balance / pool_token_balance
```

This ratio starts at 1.0 and increases over time as rewards are deposited.

## 2. Step-by-Step Example

### Setup: Epoch 10

A validator's pool starts with these values:

```
StakingPoolV1 {
    iota_balance:        100,000 IOTA
    pool_token_balance:  100,000 tokens
    rewards_pool:        0 IOTA
    pending_stake:       0
    pending_total_iota_withdraw: 0
    pending_pool_token_withdraw: 0
}

Exchange rate at epoch 10: {iota_amount: 100,000, pool_token_amount: 100,000}
Rate = 100,000 / 100,000 = 1.000
```

### Alice stakes 10,000 IOTA during epoch 10

When Alice calls `request_add_stake`, the system creates:

```
StakedIota {
    pool_id:                <this pool>
    stake_activation_epoch: 11        // active next epoch
    principal:              10,000 IOTA
}
```

The pool's `pending_stake` increases:

```
pending_stake: 0 → 10,000
```

Nothing else changes yet. Alice's stake is pending.

### Epoch 10 → 11 boundary: reward distribution + processing

Three things happen in this order:

#### (a) Rewards are deposited (`deposit_rewards`)

The protocol allocates 500 IOTA to this validator's pool (after commission extraction — see section 3 for how commission works). This goes into `iota_balance` and `rewards_pool`:

```
iota_balance:  100,000 → 100,500   (+500 reward)
rewards_pool:  0       → 500
pool_token_balance: 100,000         (unchanged — this is how the rate rises)
```

Rate is now 100,500 / 100,000 = **1.005** (but this isn't recorded yet).

#### (b) Pending withdrawals are processed (`process_pending_stake_withdraw`)

```
iota_balance       -= pending_total_iota_withdraw    (= 0, nothing to do)
pool_token_balance -= pending_pool_token_withdraw    (= 0, nothing to do)
```

Both pending withdrawal counters reset to 0.

#### (c) Pending stakes are processed (`process_pending_stake`)

This is the critical step. The code:

```
latest_rate = {iota_amount: 100,500,  pool_token_amount: 100,000}

iota_balance = 100,500 + 10,000 = 110,500    // add pending stake
pool_token_balance = get_token_amount(latest_rate, 110,500)
                   = 100,000 * 110,500 / 100,500
                   = 109,950 tokens            // mint new tokens at current rate

pending_stake = 0
```

Alice's 10,000 IOTA received `10,000 * 100,000 / 100,500 = 9,950` new pool tokens.

#### (d) Exchange rate is recorded for epoch 11

```
exchange_rates[11] = {iota_amount: 110,500, pool_token_amount: 109,950}
Rate = 110,500 / 109,950 = 1.005
```

**Pool state after epoch 10 → 11 boundary:**

```
iota_balance:        110,500
pool_token_balance:  109,950
rewards_pool:        500
exchange_rates[11]:  {110,500, 109,950}
```

### Bob stakes 5,000 IOTA during epoch 11

```
StakedIota {
    pool_id:                <this pool>
    stake_activation_epoch: 12
    principal:              5,000 IOTA
}

pending_stake: 0 → 5,000
```

### Epoch 11 → 12 boundary

#### (a) Rewards deposited: 550 IOTA (slightly more because the pool is bigger)

```
iota_balance:  110,500 → 111,050
rewards_pool:  500     → 1,050
```

#### (b) No pending withdrawals — nothing to do.

#### (c) Pending stakes processed

```
latest_rate = {iota_amount: 111,050, pool_token_amount: 109,950}

iota_balance = 111,050 + 5,000 = 116,050
pool_token_balance = 109,950 * 116,050 / 111,050 = 114,893

pending_stake = 0
```

Bob's 5,000 IOTA received `5,000 * 109,950 / 111,050 = 4,950` new pool tokens.

#### (d) Exchange rate recorded

```
exchange_rates[12] = {iota_amount: 116,050, pool_token_amount: 114,893}
Rate = 116,050 / 114,893 = 1.010
```

### Alice withdraws during epoch 12

Alice calls `request_withdraw_stake` with her `StakedIota {principal: 10,000, stake_activation_epoch: 11}`.

**Step 1: Convert principal to pool tokens using the rate at activation epoch 11**

```
exchange_rates[11] = {iota_amount: 110,500, pool_token_amount: 109,950}

pool_tokens = 10,000 * 109,950 / 110,500 = 9,950
```

These 9,950 pool tokens represent Alice's share of the pool.

**Step 2: Convert pool tokens to IOTA using the current epoch's rate**

The current exchange rate (at epoch 12, when the withdrawal happens):

```
exchange_rates[12] = {iota_amount: 116,050, pool_token_amount: 114,893}

total_iota = 9,950 * 116,050 / 114,893 = 10,050
```

**Step 3: Compute reward**

```
reward = total_iota - principal = 10,050 - 10,000 = 50 IOTA
```

**Alice receives 10,050 IOTA** (10,000 principal + 50 reward).

The 10,000 principal comes from her `StakedIota` object. The 50 reward is split from the pool's `rewards_pool`.

The pool records the pending withdrawal:

```
pending_total_iota_withdraw += 10,050
pending_pool_token_withdraw += 9,950
```

These will be subtracted from the pool at the next epoch boundary.

### Bob withdraws during epoch 14

Suppose two more epochs pass, each adding 600 IOTA in rewards (pool grew). By epoch 14:

```
exchange_rates[14] = {iota_amount: ~112,000, pool_token_amount: ~104,943}
Rate ≈ 1.067
```

Bob's `StakedIota {principal: 5,000, stake_activation_epoch: 12}`:

```
pool_tokens = 5,000 * 114,893 / 116,050 = 4,950

total_iota = 4,950 * 112,000 / 104,943 = 5,282

reward = 5,282 - 5,000 = 282 IOTA
```

**Bob receives 5,282 IOTA** (5,000 principal + 282 reward).

Bob accumulated rewards for 2 epochs (12→14). Alice only accumulated for 1 epoch (11→12) before withdrawing, so she earned less.

### Key observation

The formula for any withdrawal is always:

```
withdrawal = principal × rate_at_withdrawal / rate_at_activation
```

The principal in `StakedIota` determines how many pool tokens you have. The exchange rates at activation and withdrawal determine the return. Everything between those two points — reward deposits, other stakers joining/leaving — is captured in how the rate evolved.

## 3. Reward Distribution: How the Network Allocates Rewards

At each epoch boundary, before the pool processing described above, the network distributes rewards to validators:

### Step 1: Proportional allocation by voting power

Total staking rewards are split across **committee validators** proportional to their **voting power** (not their raw stake):

```
validator_reward = validator_voting_power × total_staking_reward / 10,000
```

Voting power is expressed in basis points (total = 10,000 across all committee members). Each validator's voting power is proportional to their stake, but **capped at 10%** (1,000 basis points). Excess voting power from capped validators is redistributed to others.

With the current number of validators, no single validator is near the 10% cap, so voting power is approximately proportional to stake. However, the redistribution algorithm introduces slight rounding differences, which means voting power is never exactly proportional — this creates small but real APY differences between validators of similar size.

### Step 2: Score-based adjustment (not yet active)

The protocol includes a mechanism to scale rewards by validator performance score:

```
score_adjusted_reward = score × unadjusted_reward / 65,536
```

**Currently, all validators receive a perfect score (65,536), so this has no effect.** When activated, lower scores (from missed proposals, poor responsiveness) would reduce rewards proportionally.

### Step 3: Slashing (not yet active)

The protocol includes a mechanism to slash rewards for validators reported by peers:

```
slashed_amount = adjusted_reward × slashing_rate / 10,000
final_reward = adjusted_reward - slashed_amount
```

**Currently, no slashing is performed.** This mechanism exists in the code but is not enforced.

### Step 4: Commission extraction (IIP-8)

The validator's commission is extracted from the reward:

```
effective_commission_rate = max(declared_commission_rate, voting_power)    # IIP-8
commission = reward × effective_commission_rate / 10,000
staker_reward = reward - commission
```

**IIP-8 (Dynamic Minimum Commission)** enforces that a validator's effective commission is at least as high as their voting power percentage. This means larger validators (higher voting power) pay a higher effective commission even if their declared rate is low, making them less attractive for delegators and encouraging stake decentralization.

Example:
- Validator with 2% declared commission and 5% voting power → effective commission = 5%
- Validator with 8% declared commission and 3% voting power → effective commission = 8%
- Validator with 1% declared commission and 10% voting power → effective commission = 10%

The commission is deposited as a new `StakedIota` to the validator's own address (it compounds like any other stake, entering the pool as `pending_stake`).

### Step 5: Auto-compounding into the pool

The remaining `staker_reward` is passed to `deposit_rewards`, which adds it to `iota_balance` and `rewards_pool` **without minting new pool tokens**. This is what causes the exchange rate to rise — the same number of pool tokens now represents more IOTA.

### Commission example with numbers

Continuing from our example above. Say the validator has 3% declared commission and 4% voting power (so 4% effective under IIP-8), and the network allocates 572 IOTA to this validator:

```
effective_commission = max(3%, 4%) = 4%
commission = 572 × 400 / 10,000 = 22 IOTA  → sent to validator as new StakedIota
staker_reward = 572 - 22 = 550 IOTA         → deposited into pool via deposit_rewards
```

This is the 550 IOTA from our epoch 10→11 example. The validator's 22 IOTA commission becomes a new `StakedIota` that enters the pool as `pending_stake` and starts compounding just like any other stake.

## 4. The Epoch Boundary Sequence

Putting it all together, here is the exact order of operations at each epoch boundary for each validator's pool:

```
1. deposit_rewards(staker_reward)
   → iota_balance += staker_reward
   → rewards_pool += staker_reward
   (pool_token_balance unchanged — rate rises)

2. process_pending_stake_withdraw()
   → iota_balance        -= pending_total_iota_withdraw
   → pool_token_balance  -= pending_pool_token_withdraw
   → reset both to 0

3. process_pending_stake()
   → iota_balance        += pending_stake
   → pool_token_balance  = get_token_amount(current_rate, new_iota_balance)
     (effectively mints new tokens for pending stakers at the post-reward rate)
   → pending_stake = 0

4. Record exchange rate for (current_epoch + 1)
   → exchange_rates[new_epoch] = {iota_balance, pool_token_balance}
```

The exchange rate recorded at step 4 is what new stakers (whose `stake_activation_epoch = new_epoch`) will use as their entry price. It reflects rewards already deposited and all pending operations already processed.

## 5. What Affects APY Besides Commission?

Even when effective commission is identical and hasn't changed between epochs, per-epoch APY can vary between validators. With score adjustment and slashing both inactive, the remaining factors are:

### Pending stake and withdrawal timing

This is the **primary cause** of per-epoch APY variation today.

In step 3 above, pending stakes cause new pool tokens to be minted, which dilutes the rate increase. In step 2, pending withdrawals burn pool tokens, which concentrates the rate increase. These effects depend entirely on staker activity during each epoch.

Example from our walkthrough: if Alice had not staked during epoch 10, the exchange rate at epoch 11 would have been:

```
Without Alice: rate = 100,500 / 100,000 = 1.005000
With Alice:    rate = 110,500 / 109,950 = 1.005002  (almost identical)
```

But if 50,000 IOTA of pending withdrawals had been processed:

```
After withdrawals: iota_balance = 100,500 - 50,000 = 50,500
                   pool_token_balance = 100,000 - 49,751 = 50,249
Rate = 50,500 / 50,249 = 1.005  (same rate, but...)
```

The rate is the same, but in the *next* epoch, the same 500 IOTA reward deposited into a pool with only 50,500 IOTA instead of 100,500 would produce a much larger rate jump (~0.99% vs ~0.50%).

This is why a validator can have a sudden APY spike after a large withdrawal — the same reward is spread across fewer remaining pool tokens, producing a larger rate increase for that epoch.

### Voting power ≠ stake proportion

Rewards are distributed by voting power, not raw stake. Even without hitting the 10% cap, the voting power redistribution algorithm introduces rounding differences. Two validators with similar stake and commission can have slightly different voting-power-to-stake ratios, producing slightly different APY.

This effect is small (fractions of a basis point) but persistent across epochs.

### Validator's own commission stake

When commission is extracted, it's deposited as a new `StakedIota` to the validator. This increases the pool's `pending_stake` for the next epoch. Validators with higher effective commission have a larger pending commission deposit, which slightly dilutes the next epoch's rate increase for delegators.

### Why APY is the right metric

Since APY reflects all of these factors (commission, voting power ratio, pending operations), it captures the actual return stakers receive. Two validators with the same declared commission can have meaningfully different APYs. Commission alone is not a reliable predictor of returns.

## 6. Summary

| Concept | Mechanism |
|---------|-----------|
| Reward tracking | Exchange rate (`iota_balance / pool_token_balance`), not balance updates |
| Compounding | Automatic — rewards increase `iota_balance`, raising the exchange rate |
| Withdrawal formula | `principal × rate_at_withdrawal / rate_at_activation` |
| Pool token accounting | Not stored per staker — computed from principal and activation epoch rate |
| Reward distribution | Proportional to voting power (capped at 10%), not raw stake |
| Commission | `max(declared_rate, voting_power)` extracted before pool deposit (IIP-8) |
| APY variation | Pending operations (primary), voting power rounding, commission reinvestment |
| Not yet active | Score-based adjustment (all scores are full), reward slashing (not enforced) |
