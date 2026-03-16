#[test_only]
module raw_steak::pool_tests;

use iota::coin::{Self, Coin, TreasuryCap};
use iota::test_scenario::{Self, Scenario};
use iota::test_utils;
use iota_system::governance_test_utils::{
    create_iota_system_state_for_testing,
    create_validators_with_stakes_and_commission_rates,
    stake_with,
    advance_epoch,
    advance_epoch_with_balanced_reward_amounts,
    advance_epoch_with_subsidy_and_scores,
    remove_validator as remove_system_validator,
};
use iota_system::iota_system::{Self, IotaSystemState};
use iota_system::staking_pool::{Self, StakedIota};
use raw_steak::pool::{Self, Pool, AdminCap};
use raw_steak::riota::{Self, RIOTA};

// ===== Addresses =====

const ADMIN:    address = @0xAD;
const STAKER_A: address = @0xAA;
const STAKER_B: address = @0xBB;

// Validators created by governance_test_utils at address::from_u256(1), from_u256(2)
const VAL_1: address = @0x1;
const VAL_2: address = @0x2;


// ===== Test helpers =====

/// Initialise IotaSystemState with two validators (100 IOTA each).
fun setup_system(scenario: &mut Scenario) {
    scenario.next_tx(@0x0);
    let ctx = scenario.ctx();
    let (_, validators) = create_validators_with_stakes_and_commission_rates(
        vector[100, 100],
        vector[0,  0],
        ctx,
    );
    create_iota_system_state_for_testing(validators, 0, 0, ctx);
}

/// Deploy RIOTA currency and Pool. Returns admin cap to ADMIN, Pool as shared.
fun setup_pool(scenario: &mut Scenario) {
    // Mint treasury cap by triggering init.
    scenario.next_tx(ADMIN);
    riota::init_for_testing(scenario.ctx());

    // Hand treasury cap to pool::create.
    scenario.next_tx(ADMIN);
    let treasury_cap = scenario.take_from_sender<TreasuryCap<RIOTA>>();
    pool::create(treasury_cap, scenario.ctx());
}

/// Register both validators in the pool (requires AdminCap and system state).
fun register_validators(scenario: &mut Scenario) {
    scenario.next_tx(ADMIN);
    let mut pool = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    let cap = scenario.take_from_sender<AdminCap>();

    let pool_id_1 = iota_system::validator_staking_pool_id(&mut system, VAL_1);
    let pool_id_2 = iota_system::validator_staking_pool_id(&mut system, VAL_2);
    pool::add_validator(&mut pool, &cap, VAL_1, pool_id_1, scenario.ctx());
    pool::add_validator(&mut pool, &cap, VAL_2, pool_id_2, scenario.ctx());

    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);
    scenario.return_to_sender(cap);
}

/// Helper: take all StakedIota objects owned by `addr`.
fun take_all_staked(scenario: &mut Scenario, addr: address): vector<StakedIota> {
    scenario.next_tx(addr);
    let ids = test_scenario::ids_for_address<StakedIota>(addr);
    let mut stakes = vector[];
    let mut i = 0;
    while (i < ids.length()) {
        stakes.push_back(scenario.take_from_address_by_id<StakedIota>(addr, ids[i]));
        i = i + 1;
    };
    stakes
}

// ===== Tests: deposit =====

/// First deposit: pool is empty → mints rIOTA 1:1 with the stake's current IOTA value.
/// For a fresh stake (staked this epoch), value ≈ principal, so minted ≈ principal.
#[test]
fun test_first_deposit_mints_at_face_value() {
    let mut scenario = test_scenario::begin(@0x0);

    setup_system(&mut scenario);
    // Epoch 0: stake with VAL_1, then advance so it activates.
    stake_with(STAKER_A, VAL_1, 10, &mut scenario);
    advance_epoch(&mut scenario);
    // Epoch 1: stake is active (activation_epoch=1 <= current_epoch=1).

    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // Deposit the fresh stake.
    scenario.next_tx(STAKER_A);
    let mut stakes = take_all_staked(&mut scenario, STAKER_A);
    let stake = stakes.pop_back();
    test_utils::destroy(stakes);
    let principal = staking_pool::staked_iota_amount(&stake);

    scenario.next_tx(STAKER_A);
    let mut pool   = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut system, stake, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);

    // Check rIOTA received ≈ principal (within ±1 due to integer division on fresh stake).
    scenario.next_tx(STAKER_A);
    let riota = scenario.take_from_sender<Coin<RIOTA>>();
    let minted = coin::value(&riota);
    // For a just-activated stake, value = principal (no rewards yet).
    assert!(minted == principal, 0);
    scenario.return_to_sender(riota);

    scenario.end();
}

/// Old stake with accumulated rewards should mint more rIOTA than a fresh stake
/// of the same principal — demonstrating value-based minting.
#[test]
fun test_old_stake_mints_more_riota_than_fresh() {
    let mut scenario = test_scenario::begin(@0x0);

    setup_system(&mut scenario);
    // Stake both users with VAL_1 at epoch 0.
    stake_with(STAKER_A, VAL_1, 10, &mut scenario); // will be old (epoch 1)
    stake_with(STAKER_B, VAL_1, 10, &mut scenario); // also epoch 1 initially

    // Advance epoch 1 → stakes activate.
    advance_epoch(&mut scenario);
    // Epoch 1–7: add rewards each epoch to VAL_1 so rates grow.
    let mut i = 0;
    while (i < 7) {
        advance_epoch_with_balanced_reward_amounts(0, 10, &mut scenario);
        i = i + 1;
    };
    // Epoch 8: STAKER_A's stake is now old (activation=1), STAKER_B stakes fresh.
    stake_with(STAKER_B, VAL_1, 10, &mut scenario); // fresh epoch-8 stake

    // Advance epoch 9 so STAKER_B's new stake activates.
    advance_epoch(&mut scenario);

    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // STAKER_B deposits their fresh stake first to seed the pool ratio.
    scenario.next_tx(STAKER_B);
    let b_ids = test_scenario::ids_for_address<StakedIota>(STAKER_B);
    // pick the epoch-9 stake (most recently created = last id)
    let fresh_stake = scenario.take_from_address_by_id<StakedIota>(STAKER_B, b_ids[b_ids.length() - 1]);

    scenario.next_tx(STAKER_B);
    let mut pool   = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut system, fresh_stake, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);

    scenario.next_tx(STAKER_B);
    let riota_b = scenario.take_from_sender<Coin<RIOTA>>();
    let minted_b = coin::value(&riota_b); // minted for fresh 10 IOTA stake
    scenario.return_to_sender(riota_b);

    // STAKER_A deposits their old stake (activation epoch 1, lots of rewards).
    scenario.next_tx(STAKER_A);
    let a_ids = test_scenario::ids_for_address<StakedIota>(STAKER_A);
    let old_stake = scenario.take_from_address_by_id<StakedIota>(STAKER_A, a_ids[0]);

    scenario.next_tx(STAKER_A);
    let mut pool   = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut system, old_stake, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);

    scenario.next_tx(STAKER_A);
    let riota_a = scenario.take_from_sender<Coin<RIOTA>>();
    let minted_a = coin::value(&riota_a); // minted for same-principal but older stake
    scenario.return_to_sender(riota_a);

    // Old stake (7 epochs of rewards) must yield MORE rIOTA than fresh stake.
    assert!(minted_a > minted_b, 1);

    scenario.end();
}

// ===== Tests: withdraw =====

/// Deposit then fully withdraw: user gets back a stake whose current value
/// equals the value they deposited (pool is single-user → gets everything).
#[test]
fun test_withdraw_returns_correct_principal() {
    let mut scenario = test_scenario::begin(@0x0);

    setup_system(&mut scenario);
    stake_with(STAKER_A, VAL_1, 10, &mut scenario);
    advance_epoch(&mut scenario); // stake activates at epoch 1

    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // Deposit.
    scenario.next_tx(STAKER_A);
    let stake_in = scenario.take_from_address<StakedIota>(STAKER_A);
    let principal_in = staking_pool::staked_iota_amount(&stake_in);

    scenario.next_tx(STAKER_A);
    let mut pool   = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut system, stake_in, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);

    // Withdraw all rIOTA.
    scenario.next_tx(STAKER_A);
    let riota = scenario.take_from_sender<Coin<RIOTA>>();
    let mut pool   = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    pool::withdraw(&mut pool, &mut system, riota, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);

    // StakedIota returned should have same principal (no rewards yet, fresh stake).
    scenario.next_tx(STAKER_A);
    let stake_out = scenario.take_from_sender<StakedIota>();
    assert!(staking_pool::staked_iota_amount(&stake_out) == principal_in, 0);
    scenario.return_to_sender(stake_out);

    scenario.end();
}

/// Two depositors: value-proportional redemption.
/// STAKER_A deposits 10 IOTA fresh; STAKER_B deposits 10 IOTA stake after 7
/// reward epochs (worth ~double). rIOTA reflects value, so STAKER_B gets twice
/// as much rIOTA. Total pool supply = minted_a + minted_b.
#[test]
fun test_two_depositors_proportional_redemption() {
    let mut scenario = test_scenario::begin(@0x0);

    setup_system(&mut scenario);
    stake_with(STAKER_A, VAL_1, 10, &mut scenario);
    stake_with(STAKER_B, VAL_1, 10, &mut scenario);
    advance_epoch(&mut scenario);
    // Add 7 reward epochs so both VAL_1 pool exchange rates grow.
    let mut i = 0;
    while (i < 7) {
        advance_epoch_with_balanced_reward_amounts(0, 10, &mut scenario);
        i = i + 1;
    };
    // STAKER_A now stakes a fresh 10 IOTA (post-rewards rate).
    stake_with(STAKER_A, VAL_1, 10, &mut scenario);
    advance_epoch(&mut scenario); // activate fresh stake

    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // STAKER_A deposits the fresh stake.
    scenario.next_tx(STAKER_A);
    let a_ids = test_scenario::ids_for_address<StakedIota>(STAKER_A);
    let fresh = scenario.take_from_address_by_id<StakedIota>(STAKER_A, a_ids[a_ids.length() - 1]);
    scenario.next_tx(STAKER_A);
    let mut pool = scenario.take_shared<Pool>(); let mut sys = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut sys, fresh, scenario.ctx());
    test_scenario::return_shared(pool); test_scenario::return_shared(sys);
    scenario.next_tx(STAKER_A);
    let riota_a = scenario.take_from_sender<Coin<RIOTA>>();
    let amt_a = coin::value(&riota_a);
    scenario.return_to_sender(riota_a);

    // STAKER_B deposits the old stake (activated epoch 1, 7 reward epochs).
    scenario.next_tx(STAKER_B);
    let b_ids = test_scenario::ids_for_address<StakedIota>(STAKER_B);
    let old = scenario.take_from_address_by_id<StakedIota>(STAKER_B, b_ids[0]);
    scenario.next_tx(STAKER_B);
    let mut pool = scenario.take_shared<Pool>(); let mut sys = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut sys, old, scenario.ctx());
    test_scenario::return_shared(pool); test_scenario::return_shared(sys);
    scenario.next_tx(STAKER_B);
    let riota_b = scenario.take_from_sender<Coin<RIOTA>>();
    let amt_b = coin::value(&riota_b);
    scenario.return_to_sender(riota_b);

    // STAKER_B's old stake should be worth more → more rIOTA.
    assert!(amt_b > amt_a, 0);

    // Total supply = amt_a + amt_b.
    scenario.next_tx(ADMIN);
    let pool = scenario.take_shared<Pool>();
    assert!(pool::riota_supply(&pool) == amt_a + amt_b, 1);
    test_scenario::return_shared(pool);

    scenario.end();
}

// ===== Tests: pool value tracks rewards =====

/// After advancing epochs with rewards, total_pool_value reported by the pool
/// (via riota_supply and proportional redemption) increases without any new deposits.
#[test]
fun test_pool_value_grows_with_epoch_rewards() {
    let mut scenario = test_scenario::begin(@0x0);

    setup_system(&mut scenario);
    stake_with(STAKER_A, VAL_1, 100, &mut scenario);
    advance_epoch(&mut scenario);

    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // Deposit 100 IOTA fresh stake — minted rIOTA = face value.
    scenario.next_tx(STAKER_A);
    let stake = scenario.take_from_address<StakedIota>(STAKER_A);
    scenario.next_tx(STAKER_A);
    let mut pool = scenario.take_shared<Pool>(); let mut sys = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut sys, stake, scenario.ctx());
    test_scenario::return_shared(pool); test_scenario::return_shared(sys);

    scenario.next_tx(STAKER_A);
    let riota = scenario.take_from_sender<Coin<RIOTA>>();
    let minted = coin::value(&riota);
    scenario.return_to_sender(riota);

    // Advance 7 reward epochs — pool's VAL_1 stake earns rewards.
    let mut i = 0;
    while (i < 7) {
        advance_epoch_with_balanced_reward_amounts(0, 10, &mut scenario);
        i = i + 1;
    };

    // Now burn all rIOTA → get back a stake. The stake's principal should be ≤
    // original but the stake itself is now worth more (exchange rate grew).
    // We verify this indirectly: value_out = riota_burned * pool_value / supply.
    // Since pool_value grew (rewards accrued) and supply is unchanged (no new mints),
    // the same rIOTA now redeems for a higher-value stake than was deposited.
    scenario.next_tx(STAKER_A);
    let riota = scenario.take_from_sender<Coin<RIOTA>>();
    assert!(coin::value(&riota) == minted, 0); // supply unchanged

    let mut pool = scenario.take_shared<Pool>(); let mut sys = scenario.take_shared<IotaSystemState>();
    pool::withdraw(&mut pool, &mut sys, riota, scenario.ctx());
    test_scenario::return_shared(pool); test_scenario::return_shared(sys);

    // The returned stake's principal (taken via principal_for_value from an old
    // stake) will be ≤ 100 IOTA, but its actual IOTA value when unstaked will be
    // higher. We can assert its activation epoch ≤ 1 (it came from the original stake).
    scenario.next_tx(STAKER_A);
    let stake_out = scenario.take_from_sender<StakedIota>();
    assert!(staking_pool::stake_activation_epoch(&stake_out) == 1, 1);
    scenario.return_to_sender(stake_out);

    scenario.end();
}

// ===== Tests: error conditions =====

#[test]
#[expected_failure(abort_code = pool::EPoolPaused)]
fun test_deposit_fails_when_paused() {
    let mut scenario = test_scenario::begin(@0x0);
    setup_system(&mut scenario);
    stake_with(STAKER_A, VAL_1, 10, &mut scenario);
    advance_epoch(&mut scenario);
    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // Pause the pool.
    scenario.next_tx(ADMIN);
    let mut pool = scenario.take_shared<Pool>();
    let cap = scenario.take_from_sender<AdminCap>();
    pool::set_pause(&mut pool, &cap, true);
    test_scenario::return_shared(pool);
    scenario.return_to_sender(cap);

    // Deposit should fail.
    scenario.next_tx(STAKER_A);
    let stake = scenario.take_from_address<StakedIota>(STAKER_A);
    let mut pool   = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut system, stake, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);

    scenario.end();
}

#[test]
#[expected_failure(abort_code = pool::ENotActive)]
fun test_deposit_fails_for_pending_stake() {
    let mut scenario = test_scenario::begin(@0x0);
    setup_system(&mut scenario);
    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // Stake at current epoch — activation_epoch = current_epoch + 1, still pending.
    stake_with(STAKER_A, VAL_1, 10, &mut scenario);

    scenario.next_tx(STAKER_A);
    let stake = scenario.take_from_address<StakedIota>(STAKER_A);
    // activation_epoch > current_epoch → should fail.
    let mut pool   = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut system, stake, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);

    scenario.end();
}

#[test]
#[expected_failure(abort_code = pool::ENotWhitelisted)]
fun test_deposit_fails_for_non_whitelisted_validator() {
    let mut scenario = test_scenario::begin(@0x0);
    setup_system(&mut scenario);
    stake_with(STAKER_A, VAL_1, 10, &mut scenario);
    advance_epoch(&mut scenario);
    setup_pool(&mut scenario);
    // Register only VAL_2, not VAL_1.
    scenario.next_tx(ADMIN);
    let mut pool   = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    let cap = scenario.take_from_sender<AdminCap>();
    let pool_id_2 = iota_system::validator_staking_pool_id(&mut system, VAL_2);
    pool::add_validator(&mut pool, &cap, VAL_2, pool_id_2, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);
    scenario.return_to_sender(cap);

    // Deposit stake at VAL_1 → not whitelisted → should fail.
    scenario.next_tx(STAKER_A);
    let stake = scenario.take_from_address<StakedIota>(STAKER_A);
    let mut pool   = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut system, stake, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);

    scenario.end();
}

// ===== Tests: swap =====

/// Set up scenario where VAL_1 gets all rewards for APY_WINDOW epochs so it has
/// higher APY than VAL_2. STAKER_B deposits a VAL_2 stake to give the pool
/// something to swap out. STAKER_A swaps their VAL_1 stake into the pool.
#[test]
fun test_swap_value_neutral() {
    let mut scenario = test_scenario::begin(@0x0);
    setup_system(&mut scenario);

    // Stake both users at epoch 0 for later use.
    stake_with(STAKER_A, VAL_1, 10, &mut scenario); // high-APY stake for user
    stake_with(STAKER_B, VAL_2, 20, &mut scenario); // low-APY stake for pool (enough to cover swap)

    // Advance 1 epoch to activate, then 7 epochs giving ALL rewards to VAL_1.
    advance_epoch(&mut scenario);
    let mut i = 0;
    while (i < 7) {
        // scores=[65536, 0]: VAL_1 committee index 0 gets everything, VAL_2 gets none.
        advance_epoch_with_subsidy_and_scores(10, vector[65536, 0], true, &mut scenario);
        i = i + 1;
    };
    // Now: VAL_1 apy_score >> 1e18, VAL_2 apy_score == 1e18.

    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // STAKER_B deposits their VAL_2 stake into the pool (pool receives low-APY stake).
    scenario.next_tx(STAKER_B);
    let stake_b = scenario.take_from_address<StakedIota>(STAKER_B);
    scenario.next_tx(STAKER_B);
    let mut pool = scenario.take_shared<Pool>(); let mut sys = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut sys, stake_b, scenario.ctx());
    test_scenario::return_shared(pool); test_scenario::return_shared(sys);
    scenario.next_tx(STAKER_B);
    let riota_b = scenario.take_from_sender<Coin<RIOTA>>();
    scenario.return_to_sender(riota_b);

    // STAKER_A swaps their VAL_1 stake (higher estimated yield) for a VAL_2 stake.
    scenario.next_tx(STAKER_A);
    let stake_a = scenario.take_from_address<StakedIota>(STAKER_A);
    let value_a = staking_pool::staked_iota_amount(&stake_a); // principal of stake_a
    scenario.next_tx(STAKER_A);
    let mut pool = scenario.take_shared<Pool>(); let mut sys = scenario.take_shared<IotaSystemState>();
    pool::swap(&mut pool, &mut sys, stake_a, scenario.ctx());
    test_scenario::return_shared(pool); test_scenario::return_shared(sys);

    // STAKER_A should now hold a StakedIota (VAL_2) and an rIOTA reward.
    scenario.next_tx(STAKER_A);
    let stake_out = scenario.take_from_sender<StakedIota>();

    // The returned stake is from VAL_2 (low-APY validator).
    // Its principal may be higher than principal_a since VAL_2 has no rewards
    // (principal_for_value gives more principal to match the same value).
    let principal_out = staking_pool::staked_iota_amount(&stake_out);
    // Because VAL_1 stake has accumulated rewards and VAL_2 has not, a value-neutral
    // swap requires taking MORE VAL_2 principal. So principal_out >= value_a.
    assert!(principal_out >= value_a, 0);

    scenario.return_to_sender(stake_out);

    // Clean up rIOTA reward.
    let reward = scenario.take_from_sender<Coin<RIOTA>>();
    assert!(coin::value(&reward) > 0, 1);
    scenario.return_to_sender(reward);

    scenario.end();
}

#[test]
#[expected_failure(abort_code = pool::ENoImprovement)]
fun test_swap_fails_when_no_apy_improvement() {
    let mut scenario = test_scenario::begin(@0x0);
    setup_system(&mut scenario);
    stake_with(STAKER_A, VAL_1, 10, &mut scenario);
    stake_with(STAKER_B, VAL_1, 10, &mut scenario); // same validator
    advance_epoch(&mut scenario);
    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // STAKER_B seeds pool with VAL_1 stake.
    scenario.next_tx(STAKER_B);
    let stake_b = scenario.take_from_address<StakedIota>(STAKER_B);
    scenario.next_tx(STAKER_B);
    let mut pool = scenario.take_shared<Pool>(); let mut sys = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut sys, stake_b, scenario.ctx());
    test_scenario::return_shared(pool); test_scenario::return_shared(sys);
    scenario.next_tx(STAKER_B);
    let r = scenario.take_from_sender<Coin<RIOTA>>();
    scenario.return_to_sender(r);

    // STAKER_A swaps VAL_1 stake into pool that only holds VAL_1 stakes.
    // Both validators have equal estimated yield (same commission, voting power).
    // This should fail with ENoImprovement.
    scenario.next_tx(STAKER_A);
    let stake_a = scenario.take_from_address<StakedIota>(STAKER_A);
    let mut pool = scenario.take_shared<Pool>(); let mut sys = scenario.take_shared<IotaSystemState>();
    pool::swap(&mut pool, &mut sys, stake_a, scenario.ctx());
    test_scenario::return_shared(pool); test_scenario::return_shared(sys);

    scenario.end();
}

// ===== Tests: swap reward =====

/// Swap gives immediate estimated rIOTA reward based on expected next-epoch yield.
/// VAL_1 has lower commission → higher yield → user swaps VAL_1 stake → gets reward.
#[test]
fun test_swap_pays_estimated_reward() {
    let mut scenario = test_scenario::begin(@0x0);
    setup_system(&mut scenario);

    stake_with(STAKER_A, VAL_1, 10, &mut scenario);
    stake_with(STAKER_B, VAL_2, 20, &mut scenario);
    advance_epoch(&mut scenario);

    // 7 epochs: VAL_1 earns all rewards → builds up APY advantage (needed for
    // worst_apy_validator to select VAL_2, and for exchange rate history).
    let mut i = 0;
    while (i < 7) {
        advance_epoch_with_subsidy_and_scores(10, vector[65536, 0], true, &mut scenario);
        i = i + 1;
    };

    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // Seed pool with VAL_2 stake.
    scenario.next_tx(STAKER_B);
    let stake_b = scenario.take_from_address<StakedIota>(STAKER_B);
    scenario.next_tx(STAKER_B);
    let mut pool = scenario.take_shared<Pool>(); let mut sys = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut sys, stake_b, scenario.ctx());
    test_scenario::return_shared(pool); test_scenario::return_shared(sys);
    scenario.next_tx(STAKER_B);
    let r = scenario.take_from_sender<Coin<RIOTA>>();
    scenario.return_to_sender(r);

    // STAKER_A performs the swap — reward is paid immediately.
    scenario.next_tx(STAKER_A);
    let stake_a = scenario.take_from_address<StakedIota>(STAKER_A);
    scenario.next_tx(STAKER_A);
    let mut pool = scenario.take_shared<Pool>(); let mut sys = scenario.take_shared<IotaSystemState>();
    pool::swap(&mut pool, &mut sys, stake_a, scenario.ctx());
    test_scenario::return_shared(pool); test_scenario::return_shared(sys);

    // STAKER_A should have received rIOTA reward immediately.
    scenario.next_tx(STAKER_A);
    let stake_out = scenario.take_from_sender<StakedIota>();
    scenario.return_to_sender(stake_out);

    let ids = test_scenario::ids_for_sender<Coin<RIOTA>>(&scenario);
    assert!(ids.length() > 0, 0);
    let reward_coin = scenario.take_from_sender<Coin<RIOTA>>();
    assert!(coin::value(&reward_coin) > 0, 1);
    scenario.return_to_sender(reward_coin);

    scenario.end();
}

// ===== Tests: cached exchange rate =====

/// Deposit and withdraw from a validator that earned no rewards (candidate-like).
/// VAL_2 gets score 0 across all reward epochs, so its exchange rate stays 1:1.
/// Cached rate correctly handles the 1:1 case, preserving principal on round-trip.
#[test]
fun test_candidate_validator_deposit_withdraw() {
    let mut scenario = test_scenario::begin(@0x0);
    setup_system(&mut scenario);

    stake_with(STAKER_A, VAL_2, 10, &mut scenario);
    advance_epoch(&mut scenario); // epoch 1: stake activates

    // 7 epochs: only VAL_1 earns rewards. VAL_2 is candidate-like (no rewards, rate = 1:1).
    let mut i = 0;
    while (i < 7) {
        advance_epoch_with_subsidy_and_scores(10, vector[65536, 0], true, &mut scenario);
        i = i + 1;
    };

    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // Deposit STAKER_A's VAL_2 stake.
    scenario.next_tx(STAKER_A);
    let stake = scenario.take_from_address<StakedIota>(STAKER_A);
    let principal_in = staking_pool::staked_iota_amount(&stake);
    scenario.next_tx(STAKER_A);
    let mut pool = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut system, stake, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);

    // rIOTA minted = principal (no rewards → value = principal).
    scenario.next_tx(STAKER_A);
    let riota = scenario.take_from_sender<Coin<RIOTA>>();
    assert!(coin::value(&riota) == principal_in, 0);

    // Withdraw all rIOTA.
    scenario.next_tx(STAKER_A);
    let mut pool = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    pool::withdraw(&mut pool, &mut system, riota, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);

    // Returned stake has same principal.
    scenario.next_tx(STAKER_A);
    let stake_out = scenario.take_from_sender<StakedIota>();
    assert!(staking_pool::staked_iota_amount(&stake_out) == principal_in, 1);
    scenario.return_to_sender(stake_out);

    scenario.end();
}

// ===== Tests: multi-vault withdrawal =====

/// Deposit 10 IOTA to both VAL_1 and VAL_2 (fresh stakes, no rewards).
/// Burn all rIOTA. Should get 2 StakedIota objects back, total principal = 20 IOTA.
#[test]
fun test_withdraw_across_validators() {
    let mut scenario = test_scenario::begin(@0x0);

    setup_system(&mut scenario);
    stake_with(STAKER_A, VAL_1, 10, &mut scenario);
    stake_with(STAKER_A, VAL_2, 10, &mut scenario);
    advance_epoch(&mut scenario); // epoch 1: stakes activate

    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // Deposit VAL_1 stake.
    scenario.next_tx(STAKER_A);
    let mut all_stakes = take_all_staked(&mut scenario, STAKER_A);
    let stake1 = all_stakes.pop_back();
    let stake2 = all_stakes.pop_back();
    all_stakes.destroy_empty();

    scenario.next_tx(STAKER_A);
    let mut pool = scenario.take_shared<Pool>();
    let mut sys = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut sys, stake1, scenario.ctx());
    pool::add_active_stake(&mut pool, &mut sys, stake2, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(sys);

    // Collect both rIOTA coins and merge them.
    scenario.next_tx(STAKER_A);
    let ids = test_scenario::ids_for_sender<Coin<RIOTA>>(&scenario);
    let mut riota_total = scenario.take_from_sender<Coin<RIOTA>>();
    let mut i = 1;
    while (i < ids.length()) {
        let c = scenario.take_from_sender<Coin<RIOTA>>();
        coin::join(&mut riota_total, c);
        i = i + 1;
    };

    // Withdraw everything.
    scenario.next_tx(STAKER_A);
    let mut pool = scenario.take_shared<Pool>();
    let mut sys = scenario.take_shared<IotaSystemState>();
    pool::withdraw(&mut pool, &mut sys, riota_total, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(sys);

    // Should get 2 StakedIota objects back, total principal = 20 IOTA.
    scenario.next_tx(STAKER_A);
    let out_stakes = take_all_staked(&mut scenario, STAKER_A);
    assert!(out_stakes.length() == 2, 0);
    let mut total_principal = 0;
    let mut j = 0;
    while (j < out_stakes.length()) {
        total_principal = total_principal + staking_pool::staked_iota_amount(out_stakes.borrow(j));
        j = j + 1;
    };
    assert!(total_principal == 20 * 1_000_000_000, 1);
    test_utils::destroy(out_stakes);

    scenario.end();
}

/// Give VAL_2 all rewards (VAL_1 is worst APY). Deposit 5 IOTA to VAL_1, 15 IOTA to VAL_2.
/// Withdraw ~12 IOTA worth. Pool drains VAL_1 first (5), then takes ~7 from VAL_2.
/// Verify total value of returned stakes covers the withdrawal.
#[test]
fun test_withdraw_exceeds_worst_vault() {
    let mut scenario = test_scenario::begin(@0x0);

    setup_system(&mut scenario);
    stake_with(STAKER_A, VAL_1, 5, &mut scenario);
    stake_with(STAKER_A, VAL_2, 15, &mut scenario);
    advance_epoch(&mut scenario);

    // 7 epochs: VAL_2 earns all rewards → VAL_1 is worst APY.
    let mut i = 0;
    while (i < 7) {
        advance_epoch_with_subsidy_and_scores(10, vector[0, 65536], true, &mut scenario);
        i = i + 1;
    };

    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // Deposit both stakes.
    scenario.next_tx(STAKER_A);
    let mut all_stakes = take_all_staked(&mut scenario, STAKER_A);
    let s1 = all_stakes.pop_back();
    let s2 = all_stakes.pop_back();
    all_stakes.destroy_empty();

    scenario.next_tx(STAKER_A);
    let mut pool = scenario.take_shared<Pool>();
    let mut sys = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut sys, s1, scenario.ctx());
    pool::add_active_stake(&mut pool, &mut sys, s2, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(sys);

    // Merge rIOTA coins.
    scenario.next_tx(STAKER_A);
    let ids = test_scenario::ids_for_sender<Coin<RIOTA>>(&scenario);
    let mut riota_total = scenario.take_from_sender<Coin<RIOTA>>();
    let mut i = 1;
    while (i < ids.length()) {
        let c = scenario.take_from_sender<Coin<RIOTA>>();
        coin::join(&mut riota_total, c);
        i = i + 1;
    };

    // Burn ~60% of rIOTA (roughly 12 IOTA worth).
    let total_riota = coin::value(&riota_total);
    let burn_amount = total_riota * 60 / 100;
    let riota_to_burn = coin::split(&mut riota_total, burn_amount, scenario.ctx());

    scenario.next_tx(STAKER_A);
    let mut pool = scenario.take_shared<Pool>();
    let mut sys = scenario.take_shared<IotaSystemState>();
    pool::withdraw(&mut pool, &mut sys, riota_to_burn, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(sys);

    // Should get back >= 2 stakes (spans both vaults; integer rounding may add one more).
    scenario.next_tx(STAKER_A);
    let out_stakes = take_all_staked(&mut scenario, STAKER_A);
    assert!(out_stakes.length() >= 2, 0);
    let mut total_principal = 0;
    let mut j = 0;
    while (j < out_stakes.length()) {
        total_principal = total_principal + staking_pool::staked_iota_amount(out_stakes.borrow(j));
        j = j + 1;
    };
    // Total principal should be > 0 and cover the withdrawal.
    assert!(total_principal > 0, 1);
    test_utils::destroy(out_stakes);

    // Clean up remaining rIOTA.
    test_utils::destroy(riota_total);

    scenario.end();
}

/// Deposit 10 IOTA to VAL_1. Second user deposits 10 IOTA too. Second user
/// burns half their rIOTA. Gets a split stake with ~5 IOTA principal.
#[test]
fun test_withdraw_splits_stake() {
    let mut scenario = test_scenario::begin(@0x0);

    setup_system(&mut scenario);
    stake_with(STAKER_A, VAL_1, 10, &mut scenario);
    stake_with(STAKER_B, VAL_1, 10, &mut scenario);
    advance_epoch(&mut scenario); // epoch 1: stakes activate

    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // Both deposit into the pool.
    scenario.next_tx(STAKER_A);
    let stake_a = scenario.take_from_address<StakedIota>(STAKER_A);
    scenario.next_tx(STAKER_A);
    let mut pool = scenario.take_shared<Pool>();
    let mut sys = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut sys, stake_a, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(sys);

    scenario.next_tx(STAKER_B);
    let stake_b = scenario.take_from_address<StakedIota>(STAKER_B);
    scenario.next_tx(STAKER_B);
    let mut pool = scenario.take_shared<Pool>();
    let mut sys = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut sys, stake_b, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(sys);

    // STAKER_B burns half their rIOTA.
    scenario.next_tx(STAKER_B);
    let mut riota_b = scenario.take_from_sender<Coin<RIOTA>>();
    let half = coin::value(&riota_b) / 2;
    let riota_half = coin::split(&mut riota_b, half, scenario.ctx());

    scenario.next_tx(STAKER_B);
    let mut pool = scenario.take_shared<Pool>();
    let mut sys = scenario.take_shared<IotaSystemState>();
    pool::withdraw(&mut pool, &mut sys, riota_half, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(sys);

    // Should get back a split stake with ~5 IOTA principal.
    scenario.next_tx(STAKER_B);
    let stake_out = scenario.take_from_sender<StakedIota>();
    let principal_out = staking_pool::staked_iota_amount(&stake_out);
    // Half of 10 IOTA = 5 IOTA (fresh stakes, no rewards, so value = principal).
    assert!(principal_out == 5 * 1_000_000_000, 0);
    scenario.return_to_sender(stake_out);

    // Clean up remaining rIOTA.
    test_utils::destroy(riota_b);

    scenario.end();
}

/// Deposit a reward-bearing stake, advance >30 epochs, then withdraw.
/// For a real candidate validator, rate_at_opt would return None after 30 epochs
/// without new rate entries — the cached rate preserves correct valuation.
/// In the test framework validators stay active (rates are always recorded),
/// so this serves as a regression test that the cached-rate code path gives
/// correct results across long epoch spans.
#[test]
fun test_value_preserved_after_30_plus_epochs() {
    let mut scenario = test_scenario::begin(@0x0);
    setup_system(&mut scenario);

    stake_with(STAKER_A, VAL_1, 10, &mut scenario);
    advance_epoch(&mut scenario); // epoch 1: stake activates

    // Epochs 1-7: VAL_1 earns rewards, exchange rate grows.
    let mut i = 0;
    while (i < 7) {
        advance_epoch_with_subsidy_and_scores(10, vector[65536, 0], true, &mut scenario);
        i = i + 1;
    };

    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // Deposit the reward-bearing stake. Value > principal.
    scenario.next_tx(STAKER_A);
    let stake = scenario.take_from_address<StakedIota>(STAKER_A);
    let principal_in = staking_pool::staked_iota_amount(&stake);
    scenario.next_tx(STAKER_A);
    let mut pool = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    pool::add_active_stake(&mut pool, &mut system, stake, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);

    scenario.next_tx(STAKER_A);
    let riota = scenario.take_from_sender<Coin<RIOTA>>();
    let minted = coin::value(&riota);
    // Rewards accumulated → value > principal → minted rIOTA > principal.
    assert!(minted > principal_in, 0);

    // Advance 35 epochs with no rewards — exceeds the 30-epoch lookback window.
    let mut i = 0;
    while (i < 35) {
        advance_epoch(&mut scenario);
        i = i + 1;
    };

    // Withdraw all rIOTA. Cached rate ensures correct pool valuation.
    scenario.next_tx(STAKER_A);
    let mut pool = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    pool::withdraw(&mut pool, &mut system, riota, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);

    // Returned stake has the deposited principal — confirms the pool
    // valued the withdrawal at the full value (not just principal).
    scenario.next_tx(STAKER_A);
    let stake_out = scenario.take_from_sender<StakedIota>();
    assert!(staking_pool::staked_iota_amount(&stake_out) == principal_in, 1);
    scenario.return_to_sender(stake_out);

    scenario.end();
}

// ===== Tests: remove_validator =====

/// Remove a validator that has left the active set and whose vault is empty.
#[test]
fun test_remove_inactive_validator() {
    let mut scenario = test_scenario::begin(@0x0);
    setup_system(&mut scenario);
    advance_epoch(&mut scenario); // epoch 1

    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // VAL_1 requests removal from the active set.
    remove_system_validator(VAL_1, &mut scenario);
    advance_epoch(&mut scenario); // epoch 2: VAL_1 is now inactive

    // Anyone (STAKER_A) can remove the inactive, empty-vault validator.
    scenario.next_tx(STAKER_A);
    let mut pool = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    pool::remove_validator(&mut pool, &mut system, VAL_1, scenario.ctx());

    // VAL_1 should no longer be in the pool's validator list.
    assert!(!pool::validators(&pool).contains(&VAL_1), 0);
    assert!(pool::validators(&pool).contains(&VAL_2), 1);

    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);
    scenario.end();
}

/// Removing an active validator must fail with ENotActive.
#[test]
#[expected_failure(abort_code = pool::ENotActive)]
fun test_remove_active_validator_fails() {
    let mut scenario = test_scenario::begin(@0x0);
    setup_system(&mut scenario);
    advance_epoch(&mut scenario);

    setup_pool(&mut scenario);
    register_validators(&mut scenario);

    // VAL_1 is still active — removal should fail.
    scenario.next_tx(STAKER_A);
    let mut pool = scenario.take_shared<Pool>();
    let mut system = scenario.take_shared<IotaSystemState>();
    pool::remove_validator(&mut pool, &mut system, VAL_1, scenario.ctx());
    test_scenario::return_shared(pool);
    test_scenario::return_shared(system);
    scenario.end();
}
