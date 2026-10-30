package to.iris.market

internal object NativeProfileSetupGate {
    // update_profile is explicit setup. Local preferences/saves and discovery
    // remain available; rejected actions are never stored for replay.
    private val writes = setOf("publish", "close", "contact", "create_invite", "accept_invite", "send_message", "request_order", "update_order")
    fun requiresSetup(command: String, nameRequired: Boolean, demo: Boolean): Boolean =
        nameRequired && !demo && command in writes
}
