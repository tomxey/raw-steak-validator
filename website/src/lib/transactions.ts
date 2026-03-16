import { Transaction } from '@iota/iota-sdk/transactions';
import { IOTA_SYSTEM_STATE_OBJECT_ID } from '@iota/iota-sdk/utils';
import { LSP_PACKAGE_ID, LSP_POOL_ID, LSP_POOL_INITIAL_SHARED_VERSION } from '../constants';

export function createStakeTransaction(amount: bigint, validator: string) {
    const tx = new Transaction();
    tx.setGasBudget(50_000_000);
    const stakeCoin = tx.splitCoins(tx.gas, [amount]);
    tx.moveCall({
        target: '0x3::iota_system::request_add_stake',
        arguments: [
            tx.sharedObjectRef({
                objectId: IOTA_SYSTEM_STATE_OBJECT_ID,
                initialSharedVersion: 1,
                mutable: true,
            }),
            stakeCoin,
            tx.pure.address(validator),
        ],
    });
    return tx;
}

export function createUnstakeTransaction(stakedIotaId: string) {
    const tx = new Transaction();
    tx.setGasBudget(50_000_000);
    tx.moveCall({
        target: '0x3::iota_system::request_withdraw_stake',
        arguments: [
            tx.sharedObjectRef({
                objectId: IOTA_SYSTEM_STATE_OBJECT_ID,
                initialSharedVersion: 1,
                mutable: true,
            }),
            tx.object(stakedIotaId),
        ],
    });
    return tx;
}

export function createRestakeTransaction(
    stakedIotaId: string,
    newValidator: string,
    sender: string,
) {
    const tx = new Transaction();
    tx.setGasBudget(100_000_000); // 0.1 IOTA — covers withdraw + restake

    const systemState = tx.sharedObjectRef({
        objectId: IOTA_SYSTEM_STATE_OBJECT_ID,
        initialSharedVersion: 1,
        mutable: true,
    });

    // Withdraw: returns Balance<IOTA>
    const balance = tx.moveCall({
        target: '0x3::iota_system::request_withdraw_stake_non_entry',
        arguments: [systemState, tx.object(stakedIotaId)],
    });

    // Convert Balance<IOTA> → Coin<IOTA>
    const coin = tx.moveCall({
        target: '0x2::coin::from_balance',
        typeArguments: ['0x2::iota::IOTA'],
        arguments: [balance],
    });

    // Re-stake with new validator → returns StakedIota
    const newStake = tx.moveCall({
        target: '0x3::iota_system::request_add_stake_non_entry',
        arguments: [systemState, coin, tx.pure.address(newValidator)],
    });

    // Transfer the new StakedIota object to sender
    tx.transferObjects([newStake], tx.pure.address(sender));

    return tx;
}

export function createLspDepositTransaction(stakedIotaId: string) {
    const tx = new Transaction();
    tx.setGasBudget(50_000_000);
    tx.moveCall({
        target: `${LSP_PACKAGE_ID}::pool::add_active_stake`,
        arguments: [
            tx.sharedObjectRef({
                objectId: LSP_POOL_ID,
                initialSharedVersion: LSP_POOL_INITIAL_SHARED_VERSION,
                mutable: true,
            }),
            tx.sharedObjectRef({
                objectId: IOTA_SYSTEM_STATE_OBJECT_ID,
                initialSharedVersion: 1,
                mutable: true,
            }),
            tx.object(stakedIotaId),
        ],
    });
    return tx;
}

export function createLspWithdrawTransaction(
    coinObjectIds: string[],
    amountNanos: bigint,
    totalBalanceNanos: bigint,
) {
    const tx = new Transaction();
    tx.setGasBudget(100_000_000); // 0.1 IOTA — withdraw involves internal unstaking

    let coin;
    if (coinObjectIds.length === 1 && amountNanos === totalBalanceNanos) {
        // Single coin, full withdrawal — use directly
        coin = tx.object(coinObjectIds[0]);
    } else {
        // Merge all coins into the first, then split exact amount
        const primary = tx.object(coinObjectIds[0]);
        if (coinObjectIds.length > 1) {
            tx.mergeCoins(
                primary,
                coinObjectIds.slice(1).map((id) => tx.object(id)),
            );
        }
        if (amountNanos < totalBalanceNanos) {
            coin = tx.splitCoins(primary, [amountNanos]);
        } else {
            coin = primary;
        }
    }

    tx.moveCall({
        target: `${LSP_PACKAGE_ID}::pool::withdraw`,
        arguments: [
            tx.sharedObjectRef({
                objectId: LSP_POOL_ID,
                initialSharedVersion: LSP_POOL_INITIAL_SHARED_VERSION,
                mutable: true,
            }),
            tx.sharedObjectRef({
                objectId: IOTA_SYSTEM_STATE_OBJECT_ID,
                initialSharedVersion: 1,
                mutable: true,
            }),
            coin,
        ],
    });
    return tx;
}

export function createLspSwapTransaction(
    stakedIotaId: string,
    swapAmountNanos: bigint | null,
) {
    const tx = new Transaction();
    tx.setGasBudget(100_000_000);

    const pool = tx.sharedObjectRef({
        objectId: LSP_POOL_ID,
        initialSharedVersion: LSP_POOL_INITIAL_SHARED_VERSION,
        mutable: true,
    });
    const system = tx.sharedObjectRef({
        objectId: IOTA_SYSTEM_STATE_OBJECT_ID,
        initialSharedVersion: 1,
        mutable: true,
    });

    if (swapAmountNanos !== null) {
        // Partial swap: split off swapAmount, swap the split portion
        const splitStake = tx.moveCall({
            target: '0x3::staking_pool::split',
            arguments: [tx.object(stakedIotaId), tx.pure.u64(swapAmountNanos)],
        });
        tx.moveCall({
            target: `${LSP_PACKAGE_ID}::pool::swap`,
            arguments: [pool, system, splitStake],
        });
    } else {
        // Full swap
        tx.moveCall({
            target: `${LSP_PACKAGE_ID}::pool::swap`,
            arguments: [pool, system, tx.object(stakedIotaId)],
        });
    }

    return tx;
}

export function createAddValidatorTransaction(validatorAddress: string, stakingPoolId: string) {
    const tx = new Transaction();
    tx.setGasBudget(50_000_000);
    tx.moveCall({
        target: `${LSP_PACKAGE_ID}::pool::add_validator_open`,
        arguments: [
            tx.sharedObjectRef({
                objectId: LSP_POOL_ID,
                initialSharedVersion: LSP_POOL_INITIAL_SHARED_VERSION,
                mutable: true,
            }),
            tx.sharedObjectRef({
                objectId: IOTA_SYSTEM_STATE_OBJECT_ID,
                initialSharedVersion: 1,
                mutable: true,
            }),
            tx.pure.address(validatorAddress),
            tx.pure.id(stakingPoolId),
        ],
    });
    return tx;
}
