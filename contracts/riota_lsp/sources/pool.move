/// Raw Steak LSP — active-stakes-only liquid staking pool.
///
/// Design principles:
///   - Pool only holds active StakedIota objects (no pending stakes).
///   - rIOTA tracks VALUE (not just principal). Depositing an old stake with
///     accumulated rewards mints rIOTA for the full current IOTA value, so
///     depositors are fairly compensated and existing holders are not diluted.
///   - No oracle: all value computations use on-chain staking-pool exchange-rate
///     tables (Table<epoch, PoolTokenExchangeRate>). Total pool value is derived
///     from per-vault pool-token counts — O(N validators), no stake iteration.
///   - Swap: user gives high-APY stake → gets low-APY stake of equal current
///     value + an immediate rIOTA reward estimated from the median per-epoch
///     yield differential over the last MEDIAN_WINDOW epochs (trustless,
///     derived entirely from on-chain exchange-rate history).
module raw_steak::pool {
    use iota::coin::{Self, TreasuryCap, CoinMetadata, Coin};
    use iota::event;
    use iota::object_table::{Self, ObjectTable};
    use iota::table::{Self, Table};
    use iota::dynamic_field;
    use iota_system::iota_system::{Self, IotaSystemState};
    use iota_system::staking_pool::{Self, StakedIota, PoolTokenExchangeRate};
    use raw_steak::riota::RIOTA;

    // ===== Constants =====

    const MIST_PER_IOTA: u64 = 1_000_000_000;
    const MAX_U64: u256 = 18_446_744_073_709_551_615;
    /// Epochs to look back when scoring validator APY / projected reward window.
    const APY_WINDOW: u64 = 7;
    /// Number of past epochs to sample when computing median per-epoch yield.
    const MEDIAN_WINDOW: u64 = 10;
    const YIELD_PRECISION: u256 = 1_000_000_000_000_000_000; // 1e18

    // ===== Error codes =====

    const EPoolPaused:        u64 = 0;
    const ENotActive:         u64 = 1;
    const EBelowMinStake:     u64 = 2;
    const ENoValidators:      u64 = 3;
    const ENoImprovement:     u64 = 4;
    const ENotWhitelisted:    u64 = 6;
    const EInsufficientStake: u64 = 7;
    const EZeroAmount:        u64 = 8;
    const ENotAllowed:        u64 = 9;
    const EDeprecated:        u64 = 10;

    // ===== Structs =====

    public struct AdminCap has key, store { id: UID }

    /// Per-validator storage.
    public struct Vault has store {
        /// StakedIota objects, indexed 0..count-1 (LIFO on take).
        stakes: ObjectTable<u64, StakedIota>,
        count: u64,
        /// Sum of principals (nano-IOTA). Used for vault-level accounting
        /// (sufficient-stake checks, APY candidate filtering).
        total_staked: u64,
        /// Sum of staking-pool token shares across all stakes in this vault.
        /// pool_tokens(stake) = principal × rate_at_stake_epoch.tokens / rate_at_stake_epoch.iota
        /// current_vault_value  = total_pool_tokens × rate_now.iota / rate_now.tokens
        /// This lets total_pool_value be O(N validators) with no stake iteration.
        total_pool_tokens: u128,
        /// Staking pool ID for this validator (provided at add_validator time).
        pool_id: ID,
    }

    public struct Pool has key {
        id: UID,
        vaults: Table<address, Vault>,
        validators: vector<address>,
        treasury_cap: TreasuryCap<RIOTA>,
        paused: bool,
        min_stake: u64,
        /// When non-empty, only these addresses may deposit/withdraw/swap.
        /// Empty = open to everyone.
        user_allowlist: vector<address>,
    }

    /// Dynamic-field key: epoch of last rate refresh across all vaults.
    public struct LastRefreshEpochKey has store, copy, drop {}

    /// Dynamic-field key: cached exchange rate for one validator.
    public struct CachedRateKey has store, copy, drop { validator: address }

    /// Cached exchange rate snapshot.
    public struct CachedRate has store, copy, drop { iota_amount: u64, pool_token_amount: u64 }

    /// Dynamic-field key: cached APY score for one validator.
    public struct CachedApyScoreKey has store, copy, drop { validator: address }


    // ===== Events =====

    public struct StakedEvent has copy, drop {
        staker: address, value_deposited: u64, riota_minted: u64,
    }
    public struct WithdrawnEvent has copy, drop {
        staker: address, riota_burned: u64, value_returned: u64,
    }
    public struct SwappedEvent has copy, drop {
        swapper: address,
        validator_in: address, validator_out: address,
        value_swapped: u64, riota_reward: u64,
    }

    // ===== Initialisation =====

    public entry fun create(treasury_cap: TreasuryCap<RIOTA>, ctx: &mut TxContext) {
        transfer::transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
        transfer::share_object(Pool {
            id: object::new(ctx),
            vaults: table::new(ctx),
            validators: vector[],
            treasury_cap,
            paused: false,
            min_stake: MIST_PER_IOTA,
            user_allowlist: vector[],
        });
    }

    // ===== Admin =====

    /// V1-compatible: admin can add any validator (no on-chain verification).
    public entry fun add_validator(
        pool: &mut Pool,
        _cap: &AdminCap,
        validator: address,
        pool_id: ID,
        ctx: &mut TxContext,
    ) {
        add_validator_impl(pool, validator, pool_id, ctx);
    }

    /// Allowlisted users can add validators with on-chain pool_id verification.
    public entry fun add_validator_open(
        pool: &mut Pool,
        system: &mut IotaSystemState,
        validator: address,
        pool_id: ID,
        ctx: &mut TxContext,
    ) {
        assert_allowed(pool, ctx);
        assert!(
            iota_system::validator_address_by_pool_id(system, &pool_id) == validator,
            ENotWhitelisted,
        );
        add_validator_impl(pool, validator, pool_id, ctx);
    }

    fun add_validator_impl(
        pool: &mut Pool,
        validator: address,
        pool_id: ID,
        ctx: &mut TxContext,
    ) {
        assert!(!pool.validators.contains(&validator), ENotWhitelisted);
        pool.validators.push_back(validator);
        pool.vaults.add(validator, Vault {
            stakes: object_table::new(ctx),
            count: 0,
            total_staked: 0,
            total_pool_tokens: 0,
            pool_id,
        });
    }

    public entry fun remove_validator(
        pool: &mut Pool,
        system: &mut IotaSystemState,
        validator: address,
        ctx: &mut TxContext,
    ) {
        assert_allowed(pool, ctx);
        let (found, idx) = pool.validators.index_of(&validator);
        assert!(found, ENotWhitelisted);
        let vault = pool.vaults.borrow(validator);
        assert!(vault.total_staked == 0 && vault.count == 0, EInsufficientStake);
        let active = iota_system::active_validator_addresses(system);
        assert!(!active.contains(&validator), ENotActive);
        pool.validators.swap_remove(idx);
        let Vault { stakes, count: _, total_staked: _, total_pool_tokens: _, pool_id: _ } =
            pool.vaults.remove(validator);
        stakes.destroy_empty();
    }

    public entry fun set_pause(pool: &mut Pool, _cap: &AdminCap, paused: bool) {
        pool.paused = paused;
    }

    public entry fun add_to_user_allowlist(
        pool: &mut Pool, _cap: &AdminCap, user: address,
    ) {
        if (!pool.user_allowlist.contains(&user)) {
            pool.user_allowlist.push_back(user);
        };
    }

    public entry fun remove_from_user_allowlist(
        pool: &mut Pool, _cap: &AdminCap, user: address,
    ) {
        let (found, idx) = pool.user_allowlist.index_of(&user);
        if (found) { pool.user_allowlist.swap_remove(idx); };
    }

    public entry fun update_icon_url(
        pool: &Pool, _cap: &AdminCap,
        metadata: &mut CoinMetadata<RIOTA>, url: std::ascii::String,
    ) {
        coin::update_icon_url(&pool.treasury_cap, metadata, url);
    }


    // ===== Core: add_active_stake =====

    public entry fun add_active_stake(
        pool: &mut Pool,
        system: &mut IotaSystemState,
        stake: StakedIota,
        ctx: &mut TxContext,
    ) {
        let riota = add_active_stake_non_entry(pool, system, stake, ctx);
        transfer::public_transfer(riota, ctx.sender());
    }

    public fun add_active_stake_non_entry(
        pool: &mut Pool,
        system: &mut IotaSystemState,
        stake: StakedIota,
        ctx: &mut TxContext,
    ): Coin<RIOTA> {
        assert!(!pool.paused, EPoolPaused);
        assert_allowed(pool, ctx);

        let current_epoch = ctx.epoch();
        let stake_epoch = staking_pool::stake_activation_epoch(&stake);
        assert!(stake_epoch <= current_epoch, ENotActive);
        refresh_rates(pool, system, current_epoch);

        let principal = staking_pool::staked_iota_amount(&stake);
        assert!(principal >= pool.min_stake, EBelowMinStake);

        let validator = validator_for_stake(pool, system, &stake);

        // Compute actual current IOTA value of the deposited stake.
        // This includes principal + any rewards accumulated since stake_epoch.
        let value = compute_stake_value(pool, system, validator, principal, stake_epoch);

        // rIOTA minted is proportional to VALUE deposited (not just principal),
        // so an old stake with rewards is fairly credited.
        // First deposit: 1 rIOTA per nano-IOTA of value (sets the initial rate).
        let riota_supply = coin::total_supply(&pool.treasury_cap);
        let pool_value   = total_pool_value(pool);
        let riota_out = if (riota_supply == 0 || pool_value == 0) {
            value
        } else {
            (((value as u256) * (riota_supply as u256)) / (pool_value as u256)) as u64
        };
        assert!(riota_out > 0, EZeroAmount);

        vault_add_stake(pool, validator, stake, principal, system);

        let riota = coin::mint(&mut pool.treasury_cap, riota_out, ctx);
        event::emit(StakedEvent { staker: ctx.sender(), value_deposited: value, riota_minted: riota_out });
        riota
    }

    // ===== Core: withdraw =====

    public entry fun withdraw(
        pool: &mut Pool,
        system: &mut IotaSystemState,
        riota: Coin<RIOTA>,
        ctx: &mut TxContext,
    ) {
        let (mut stakes, refund) = withdraw_multi_non_entry(pool, system, riota, ctx);
        while (stakes.length() > 0) {
            transfer::public_transfer(stakes.pop_back(), ctx.sender());
        };
        stakes.destroy_empty();
        if (coin::value(&refund) > 0) {
            transfer::public_transfer(refund, ctx.sender());
        } else {
            coin::destroy_zero(refund);
        };
    }

    /// Deprecated: use withdraw_multi_non_entry instead.
    public fun withdraw_non_entry(
        _pool: &mut Pool,
        _system: &mut IotaSystemState,
        _riota: Coin<RIOTA>,
        _ctx: &mut TxContext,
    ): StakedIota {
        abort EDeprecated
    }

    /// Multi-vault withdrawal: drains worst-APY vaults in order, returns
    /// multiple stakes and an rIOTA refund for sub-IOTA dust.
    public fun withdraw_multi_non_entry(
        pool: &mut Pool,
        system: &mut IotaSystemState,
        riota: Coin<RIOTA>,
        ctx: &mut TxContext,
    ): (vector<StakedIota>, Coin<RIOTA>) {
        assert!(!pool.paused, EPoolPaused);
        assert_allowed(pool, ctx);
        assert!(pool.validators.length() > 0, ENoValidators);

        let current_epoch = ctx.epoch();
        refresh_rates(pool, system, current_epoch);
        let riota_amount  = coin::value(&riota);
        let riota_supply  = coin::total_supply(&pool.treasury_cap);
        let pool_value = total_pool_value(pool);

        let value_out = if (riota_amount == riota_supply) {
            pool_value
        } else {
            (((riota_amount as u256) * (pool_value as u256)) / (riota_supply as u256)) as u64
        };
        assert!(value_out >= pool.min_stake, EBelowMinStake);

        coin::burn(&mut pool.treasury_cap, riota);

        let mut remaining = value_out;
        let mut result = vector[];

        while (remaining >= MIST_PER_IOTA) {
            let worst = worst_apy_validator(pool);
            if (pool.vaults.borrow(worst).total_staked == 0) break;

            let stake = vault_take_by_value(pool, worst, remaining, system, ctx);
            let taken_value = compute_stake_value(
                pool, system, worst,
                staking_pool::staked_iota_amount(&stake),
                staking_pool::stake_activation_epoch(&stake),
            );
            remaining = if (taken_value >= remaining) { 0 } else { remaining - taken_value };
            result.push_back(stake);
        };

        let refund_amount = if (remaining > 0 && remaining < MIST_PER_IOTA) {
            (((remaining as u256) * (riota_amount as u256)) / (value_out as u256)) as u64
        } else { 0 };
        let refund = coin::mint(&mut pool.treasury_cap, refund_amount, ctx);

        event::emit(WithdrawnEvent {
            staker: ctx.sender(),
            riota_burned: riota_amount - refund_amount,
            value_returned: value_out - remaining,
        });
        (result, refund)
    }

    // ===== Core: swap =====

    public entry fun swap(
        pool: &mut Pool,
        system: &mut IotaSystemState,
        stake_x: StakedIota,
        ctx: &mut TxContext,
    ) {
        let (stake_y, reward) = swap_non_entry(pool, system, stake_x, ctx);
        transfer::public_transfer(stake_y, ctx.sender());
        if (coin::value(&reward) > 0) {
            transfer::public_transfer(reward, ctx.sender());
        } else {
            coin::destroy_zero(reward);
        };
    }

    public fun swap_non_entry(
        pool: &mut Pool,
        system: &mut IotaSystemState,
        stake_x: StakedIota,
        ctx: &mut TxContext,
    ): (StakedIota, Coin<RIOTA>) {
        assert!(!pool.paused, EPoolPaused);
        assert_allowed(pool, ctx);
        assert!(pool.validators.length() > 0, ENoValidators);

        let current_epoch = ctx.epoch();
        let epoch_x       = staking_pool::stake_activation_epoch(&stake_x);
        assert!(epoch_x <= current_epoch, ENotActive);
        refresh_rates(pool, system, current_epoch);

        let principal_x = staking_pool::staked_iota_amount(&stake_x);
        assert!(principal_x >= pool.min_stake, EBelowMinStake);

        let validator_x = validator_for_stake(pool, system, &stake_x);
        let validator_y = worst_apy_validator(pool);

        let pool_id_x = pool.vaults.borrow(validator_x).pool_id;
        let pool_id_y = pool.vaults.borrow(validator_y).pool_id;

        // Median per-epoch yield over the last MEDIAN_WINDOW epochs.
        // Using median filters out reward spikes from large withdrawals.
        let yield_x = median_yield(system, pool_id_x, current_epoch);
        let yield_y = median_yield(system, pool_id_y, current_epoch);
        assert!(yield_x > yield_y, ENoImprovement);

        // Compute actual current IOTA value of stake_x (principal + rewards).
        let value_x = compute_stake_value(pool, system, validator_x, principal_x, epoch_x);

        // Give user a stake of equal current value from the worst-APY vault.
        let stake_y = vault_take_by_value(pool, validator_y, value_x, system, ctx);

        // Add the user's high-APY stake into the pool.
        vault_add_stake(pool, validator_x, stake_x, principal_x, system);

        // Reward: estimated extra IOTA the pool earns over APY_WINDOW epochs
        // thanks to the higher-yield stake, converted to rIOTA.
        //   extra_iota = value_x × APY_WINDOW × (yield_x − yield_y) / 1e18
        //   reward_riota = extra_iota × riota_supply / pool_value
        let riota_sup = coin::total_supply(&pool.treasury_cap) as u256;
        let pool_val  = total_pool_value(pool) as u256;
        let extra_iota = (value_x as u256) * (APY_WINDOW as u256) * (yield_x - yield_y)
            / YIELD_PRECISION;
        let reward_riota = if (riota_sup == 0 || pool_val == 0) {
            extra_iota as u64
        } else {
            (extra_iota * riota_sup / pool_val) as u64
        };

        let reward = coin::mint(&mut pool.treasury_cap, reward_riota, ctx);

        event::emit(SwappedEvent {
            swapper: ctx.sender(),
            validator_in: validator_x, validator_out: validator_y,
            value_swapped: value_x, riota_reward: reward_riota,
        });
        (stake_y, reward)
    }


    // ===== View =====

    public fun riota_supply(pool: &Pool): u64 { coin::total_supply(&pool.treasury_cap) }
    public fun validators(pool: &Pool): &vector<address> { &pool.validators }

    // ===== Internal helpers =====

    /// Compute the staking-pool token count for `principal` nano-IOTA staked
    /// at `stake_epoch`.
    ///   pool_tokens = principal × rate_stake.tokens / rate_stake.iota
    /// Falls back to `principal` (i.e. 1:1) if the historical rate is unavailable.
    fun compute_pool_tokens(
        system: &mut IotaSystemState,
        pool_id: ID,
        principal: u64,
        stake_epoch: u64,
    ): u128 {
        let rates    = iota_system::pool_exchange_rates(system, &pool_id);
        let rate_opt = rate_at_opt(rates, stake_epoch);
        if (rate_opt.is_none()) { return principal as u128 };
        let r      = rate_opt.destroy_some();
        let iota   = staking_pool::iota_amount(&r)       as u256;
        let tokens = staking_pool::pool_token_amount(&r) as u256;
        if (iota == 0) { return principal as u128 };
        ((principal as u256) * tokens / iota) as u128
    }

    /// If user_allowlist is non-empty, assert the sender is in it.
    fun assert_allowed(pool: &Pool, ctx: &TxContext) {
        let list = &pool.user_allowlist;
        if (list.length() > 0) {
            assert!(list.contains(&ctx.sender()), ENotAllowed);
        };
    }

    /// Refresh the cached exchange rate for every validator, once per epoch.
    /// Only searches epochs (last_refresh, current] for new rate entries.
    /// If no new rate is found (candidate validator), the previous cached
    /// value is retained — this is the key fix for long-running candidate gaps.
    /// On the very first call (last = 0, no cache yet), falls back to an
    /// unlimited search via rate_at_opt to bootstrap the cache.
    fun refresh_rates(pool: &mut Pool, system: &mut IotaSystemState, current_epoch: u64) {
        let key = LastRefreshEpochKey {};
        let last = if (dynamic_field::exists_(&pool.id, key)) {
            *dynamic_field::borrow(&pool.id, key)
        } else { 0u64 };
        if (current_epoch <= last) return;

        // Mark this epoch as refreshed.
        if (last == 0) { dynamic_field::add(&mut pool.id, key, current_epoch); }
        else { *dynamic_field::borrow_mut(&mut pool.id, key) = current_epoch; };

        let mut i = 0;
        while (i < pool.validators.length()) {
            let v     = *pool.validators.borrow(i);
            let vault = pool.vaults.borrow(v);
            let rates = iota_system::pool_exchange_rates(system, &vault.pool_id);

            // Search only the new epoch range. If no cache exists yet (first
            // call after upgrade), do a full backward search to bootstrap.
            let rk = CachedRateKey { validator: v };
            let has_cache = dynamic_field::exists_(&pool.id, rk);
            let rate_opt = if (has_cache) {
                rate_at_opt_since(rates, current_epoch, last)
            } else {
                rate_at_opt(rates, current_epoch)
            };

            if (rate_opt.is_some()) {
                let r = rate_opt.destroy_some();
                let cached = CachedRate {
                    iota_amount: staking_pool::iota_amount(&r),
                    pool_token_amount: staking_pool::pool_token_amount(&r),
                };
                if (has_cache) {
                    *dynamic_field::borrow_mut(&mut pool.id, rk) = cached;
                } else {
                    dynamic_field::add(&mut pool.id, rk, cached);
                };
            };
            // else: no new rate since last refresh → keep cached value

            // Cache APY score for this validator (used by worst_apy_validator).
            // Uses the just-cached current rate + a backward lookup for rate_ago.
            let window_start = if (current_epoch >= APY_WINDOW) { current_epoch - APY_WINDOW } else { 0 };
            let rate_ago_opt = rate_at_opt(rates, window_start);
            let sk = CachedApyScoreKey { validator: v };
            let score = {
                let has_current = dynamic_field::exists_(&pool.id, CachedRateKey { validator: v });
                if (has_current && rate_ago_opt.is_some()) {
                    let cr: &CachedRate = dynamic_field::borrow(&pool.id, CachedRateKey { validator: v });
                    let i_now = cr.iota_amount as u256;
                    let t_now = cr.pool_token_amount as u256;
                    let ra = rate_ago_opt.destroy_some();
                    let i_ago = staking_pool::iota_amount(&ra) as u256;
                    let t_ago = staking_pool::pool_token_amount(&ra) as u256;
                    if (i_ago == 0 || t_now == 0) { YIELD_PRECISION }
                    else { i_now * t_ago * YIELD_PRECISION / (t_now * i_ago) }
                } else {
                    YIELD_PRECISION
                }
            };
            if (dynamic_field::exists_(&pool.id, sk)) {
                *dynamic_field::borrow_mut<CachedApyScoreKey, u256>(&mut pool.id, sk) = score;
            } else {
                dynamic_field::add(&mut pool.id, sk, score);
            };

            i = i + 1;
        };
    }

    /// Search backwards for the most recent rate in (since_epoch, target_epoch].
    fun rate_at_opt_since(
        rates: &Table<u64, PoolTokenExchangeRate>,
        target_epoch: u64,
        since_epoch: u64,
    ): std::option::Option<PoolTokenExchangeRate> {
        let mut e = target_epoch;
        loop {
            if (table::contains(rates, e)) {
                return std::option::some(*table::borrow(rates, e))
            };
            if (e <= since_epoch) break;
            e = e - 1;
        };
        std::option::none()
    }

    /// Returns the cached (iota, tokens) as u256 for use in value formulas.
    /// Returns (0, 0) if no rate has ever been cached.
    fun cached_rate(pool: &Pool, validator: address): (u256, u256) {
        let key = CachedRateKey { validator };
        if (dynamic_field::exists_(&pool.id, key)) {
            let r: &CachedRate = dynamic_field::borrow(&pool.id, key);
            (r.iota_amount as u256, r.pool_token_amount as u256)
        } else {
            (0, 0)
        }
    }

    /// Compute the current total IOTA value of the pool by summing each vault:
    ///   vault_value = vault.total_pool_tokens × cached_rate.iota / cached_rate.tokens
    /// This is O(N validators) — no iteration over individual stakes needed.
    fun total_pool_value(pool: &Pool): u64 {
        let mut total = 0u256;
        let mut i = 0;
        while (i < pool.validators.length()) {
            let v     = *pool.validators.borrow(i);
            let vault = pool.vaults.borrow(v);
            if (vault.total_pool_tokens > 0) {
                let (c_iota, c_tokens) = cached_rate(pool, v);
                if (c_tokens > 0) {
                    total = total + (vault.total_pool_tokens as u256) * c_iota / c_tokens;
                } else {
                    // Never had a rate (e.g. fresh candidate) — use principal sum.
                    total = total + (vault.total_staked as u256);
                }
            };
            i = i + 1;
        };
        if (total > MAX_U64) { MAX_U64 as u64 } else { total as u64 }
    }

    /// Add a stake to its validator's vault. Merges with the last entry if
    /// they share pool + activation epoch. Updates `vault.total_pool_tokens`.
    fun vault_add_stake(
        pool: &mut Pool,
        validator: address,
        stake: StakedIota,
        principal: u64,
        system: &mut IotaSystemState,
    ) {
        let stake_epoch      = staking_pool::stake_activation_epoch(&stake);
        let pool_id          = pool.vaults.borrow(validator).pool_id;
        let new_pool_tokens  = compute_pool_tokens(system, pool_id, principal, stake_epoch);

        let vault = pool.vaults.borrow_mut(validator);
        // Scan for an existing stake with the same metadata to merge into.
        let mut i = 0;
        while (i < vault.count) {
            let existing = vault.stakes.borrow(i);
            if (staking_pool::is_equal_staking_metadata(existing, &stake)) {
                let existing_mut = vault.stakes.borrow_mut(i);
                staking_pool::join_staked_iota(existing_mut, stake);
                vault.total_staked       = vault.total_staked + principal;
                vault.total_pool_tokens  = vault.total_pool_tokens + new_pool_tokens;
                return
            };
            i = i + 1;
        };
        let idx = vault.count;
        vault.stakes.add(idx, stake);
        vault.count             = vault.count + 1;
        vault.total_staked      = vault.total_staked + principal;
        vault.total_pool_tokens = vault.total_pool_tokens + new_pool_tokens;
    }

    /// Remove `principal_needed` nano-IOTA of principal from a vault (LIFO).
    /// Splits if the remainder would be ≥ MIST_PER_IOTA; takes the whole
    /// object otherwise. Updates `vault.total_pool_tokens` proportionally.
    fun vault_take_principal(
        pool: &mut Pool,
        validator: address,
        principal_needed: u64,
        system: &mut IotaSystemState,
        ctx: &mut TxContext,
    ): StakedIota {
        // Read phase (immutable borrow): gather info needed before mutations.
        let (last_idx, last_principal, stake_epoch, pool_id) = {
            let vault = pool.vaults.borrow(validator);
            assert!(vault.count > 0 && vault.total_staked >= principal_needed, EInsufficientStake);
            let li   = vault.count - 1;
            let last = vault.stakes.borrow(li);
            (li,
             staking_pool::staked_iota_amount(last),
             staking_pool::stake_activation_epoch(last),
             vault.pool_id)
        };

        let will_split      = last_principal > principal_needed
                              && last_principal - principal_needed >= MIST_PER_IOTA;
        let taken_principal = if (will_split) { principal_needed } else { last_principal };

        // Compute pool tokens for the taken portion before mutating the vault.
        let pool_tokens_taken = compute_pool_tokens(system, pool_id, taken_principal, stake_epoch);

        // Mutation phase.
        let vault = pool.vaults.borrow_mut(validator);
        let result = if (will_split) {
            staking_pool::split(vault.stakes.borrow_mut(last_idx), principal_needed, ctx)
        } else {
            vault.count = vault.count - 1;
            vault.stakes.remove(last_idx)
        };

        let taken = staking_pool::staked_iota_amount(&result);
        vault.total_staked = vault.total_staked - taken;
        // Safe subtraction: pool_tokens_taken may differ by ±1 from the actual
        // stored amount due to integer-division rounding.
        vault.total_pool_tokens = if (vault.total_pool_tokens >= pool_tokens_taken) {
            vault.total_pool_tokens - pool_tokens_taken
        } else {
            0
        };
        result
    }

    /// Take a stake worth exactly `value_out` current nano-IOTA from a vault.
    /// Converts value → principal using the last stake's epoch, then delegates
    /// to `vault_take_principal`.
    fun vault_take_by_value(
        pool: &mut Pool,
        validator: address,
        value_out: u64,
        system: &mut IotaSystemState,
        ctx: &mut TxContext,
    ): StakedIota {
        let epoch_y   = vault_last_stake_epoch(pool, validator);
        let raw_p     = principal_for_value(pool, system, validator, value_out, epoch_y);
        let max_avail = pool.vaults.borrow(validator).total_staked;
        let principal = {
            let p = if (raw_p > max_avail) { max_avail } else { raw_p };
            if (p < MIST_PER_IOTA) { MIST_PER_IOTA } else { p }
        };
        vault_take_principal(pool, validator, principal, system, ctx)
    }

    /// Resolve a stake's owner validator (must be in pool whitelist).
    fun validator_for_stake(
        pool: &Pool,
        system: &mut IotaSystemState,
        stake: &StakedIota,
    ): address {
        let stake_pool_id = staking_pool::pool_id(stake);
        let validator     = iota_system::validator_address_by_pool_id(system, &stake_pool_id);
        assert!(pool.validators.contains(&validator), ENotWhitelisted);
        validator
    }

    /// Find the whitelisted validator with the lowest cached APY score among
    /// those that currently hold stakes. Reads scores cached by `refresh_rates`.
    fun worst_apy_validator(pool: &Pool): address {
        assert!(pool.validators.length() > 0, ENoValidators);
        let mut worst_addr  = *pool.validators.borrow(0);
        let mut worst_score = 0u256;
        let mut found = false;
        let mut i = 0;
        while (i < pool.validators.length()) {
            let v     = *pool.validators.borrow(i);
            let vault = pool.vaults.borrow(v);
            if (vault.total_staked > 0) {
                let sk = CachedApyScoreKey { validator: v };
                let score = if (dynamic_field::exists_(&pool.id, sk)) {
                    *dynamic_field::borrow(&pool.id, sk)
                } else { YIELD_PRECISION };
                if (!found || score < worst_score) {
                    worst_score = score;
                    worst_addr  = v;
                    found = true;
                }
            };
            i = i + 1;
        };
        worst_addr
    }

    /// Compute the current IOTA value of a StakedIota from its principal and
    /// the epoch it was staked.
    ///   value = principal × rate_now.iota × rate_stake.tokens
    ///                     / (rate_now.tokens × rate_stake.iota)
    /// Falls back to `principal` if exchange-rate history is unavailable.
    fun compute_stake_value(
        pool: &Pool,
        system: &mut IotaSystemState,
        validator: address,
        principal: u64,
        stake_epoch: u64,
    ): u64 {
        let (i_now, t_now) = cached_rate(pool, validator);
        if (t_now == 0) { return principal };

        let pool_id = pool.vaults.borrow(validator).pool_id;
        let rates          = iota_system::pool_exchange_rates(system, &pool_id);
        let rate_stake_opt = rate_at_opt(rates, stake_epoch);
        if (rate_stake_opt.is_none()) { return principal };
        let rs    = rate_stake_opt.destroy_some();
        let i_stk = staking_pool::iota_amount(&rs)         as u256;
        let t_stk = staking_pool::pool_token_amount(&rs)   as u256;
        if (i_stk == 0) { return principal };
        let v = (principal as u256) * i_now * t_stk / (t_now * i_stk);
        if (v > MAX_U64) { principal } else { v as u64 }
    }

    /// Inverse of `compute_stake_value`: return the principal needed from a
    /// stake at `stake_epoch` to have current IOTA value == `target_value`.
    ///   principal = target_value × rate_now.tokens × rate_stake.iota
    ///                            / (rate_now.iota × rate_stake.tokens)
    fun principal_for_value(
        pool: &Pool,
        system: &mut IotaSystemState,
        validator: address,
        target_value: u64,
        stake_epoch: u64,
    ): u64 {
        let (i_now, t_now) = cached_rate(pool, validator);
        if (i_now == 0) { return target_value };

        let pool_id = pool.vaults.borrow(validator).pool_id;
        let rates          = iota_system::pool_exchange_rates(system, &pool_id);
        let rate_stake_opt = rate_at_opt(rates, stake_epoch);
        if (rate_stake_opt.is_none()) { return target_value };
        let rs    = rate_stake_opt.destroy_some();
        let i_stk = staking_pool::iota_amount(&rs)         as u256;
        let t_stk = staking_pool::pool_token_amount(&rs)   as u256;
        if (t_stk == 0) { return target_value };
        let p = (target_value as u256) * t_now * i_stk / (i_now * t_stk);
        if (p > MAX_U64) { target_value } else { p as u64 }
    }

    /// Return the stake_activation_epoch of the last stake in a vault.
    fun vault_last_stake_epoch(pool: &Pool, validator: address): u64 {
        let vault = pool.vaults.borrow(validator);
        assert!(vault.count > 0, EInsufficientStake);
        staking_pool::stake_activation_epoch(vault.stakes.borrow(vault.count - 1))
    }

    /// Per-epoch yield (growth of 1 IOTA of stake) scaled by YIELD_PRECISION.
    /// Returns none if exchange-rate data is unavailable for that epoch.
    fun epoch_yield(
        rates: &Table<u64, PoolTokenExchangeRate>,
        epoch: u64,
    ): std::option::Option<u256> {
        if (epoch == 0) { return std::option::none() };
        let rate_now_opt  = rate_at_opt(rates, epoch);
        let rate_prev_opt = rate_at_opt(rates, epoch - 1);
        if (rate_now_opt.is_none() || rate_prev_opt.is_none()) {
            return std::option::none()
        };
        let rn = rate_now_opt.destroy_some();
        let rp = rate_prev_opt.destroy_some();
        let i_now  = staking_pool::iota_amount(&rn)       as u256;
        let t_now  = staking_pool::pool_token_amount(&rn)  as u256;
        let i_prev = staking_pool::iota_amount(&rp)        as u256;
        let t_prev = staking_pool::pool_token_amount(&rp)  as u256;
        if (t_now == 0 || i_prev == 0) { return std::option::none() };
        // yield = i_now/t_now / (i_prev/t_prev) − 1, scaled by YIELD_PRECISION.
        let growth = i_now * t_prev * YIELD_PRECISION / (t_now * i_prev);
        if (growth > YIELD_PRECISION) {
            std::option::some(growth - YIELD_PRECISION)
        } else {
            std::option::some(0)
        }
    }

    /// Median per-epoch yield over the last MEDIAN_WINDOW epochs.
    /// Uses the median to filter out reward spikes from large withdrawals.
    fun median_yield(
        system: &mut IotaSystemState,
        pool_id: ID,
        current_epoch: u64,
    ): u256 {
        let rates = iota_system::pool_exchange_rates(system, &pool_id);
        let mut yields = vector[];
        let start = if (current_epoch > MEDIAN_WINDOW) {
            current_epoch - MEDIAN_WINDOW
        } else {
            0
        };
        let mut e = start + 1;
        while (e <= current_epoch) {
            let y = epoch_yield(rates, e);
            if (y.is_some()) {
                yields.push_back(y.destroy_some());
            };
            e = e + 1;
        };
        let len = yields.length();
        if (len == 0) { return 0 };
        sort_u256(&mut yields);
        *yields.borrow(len / 2)
    }

    /// Insertion sort for small u256 vectors.
    fun sort_u256(v: &mut vector<u256>) {
        let len = v.length();
        if (len <= 1) return;
        let mut i = 1;
        while (i < len) {
            let mut j = i;
            while (j > 0 && *v.borrow(j - 1) > *v.borrow(j)) {
                v.swap(j - 1, j);
                j = j - 1;
            };
            i = i + 1;
        };
    }

    /// Search backwards for the most recent recorded rate at or before `target_epoch`.
    fun rate_at_opt(
        rates: &Table<u64, PoolTokenExchangeRate>,
        target_epoch: u64,
    ): std::option::Option<PoolTokenExchangeRate> {
        let mut e = target_epoch;
        loop {
            if (table::contains(rates, e)) {
                return std::option::some(*table::borrow(rates, e))
            };
            if (e == 0) break;
            e = e - 1;
        };
        std::option::none()
    }

}
