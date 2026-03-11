import { Transaction } from '@iota/iota-sdk/transactions';
import { IOTA_SYSTEM_STATE_OBJECT_ID } from '@iota/iota-sdk/utils';

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
