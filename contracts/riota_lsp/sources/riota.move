/// Defines the rIOTA liquid staking token.
/// TreasuryCap is transferred to the deployer, who passes it to pool::create.
module raw_steak::riota {
    use iota::coin;

    public struct RIOTA has drop {}

    fun init(witness: RIOTA, ctx: &mut TxContext) {
        let (treasury_cap, metadata) = coin::create_currency(
            witness,
            9,
            b"rIOTA",
            b"Raw Steak IOTA",
            b"Liquid staked IOTA - Raw Steak LSP",
            option::some(
                iota::url::new_unsafe_from_bytes(b"https://raw-steak.eu/coin_icon.png"),
            ),
            ctx,
        );
        let sender = iota::tx_context::sender(ctx);
        // Metadata goes to deployer (not frozen) so icon URL can be updated later.
        iota::transfer::public_transfer(metadata, sender);
        // Treasury cap goes to deployer, who passes it to pool::create.
        iota::transfer::public_transfer(treasury_cap, sender);
    }

    #[test_only]
    /// Call the module initialiser in tests. Transfers TreasuryCap to sender.
    public fun init_for_testing(ctx: &mut TxContext) {
        init(RIOTA {}, ctx);
    }
}
