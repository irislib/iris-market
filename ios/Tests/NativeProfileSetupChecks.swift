import Foundation

@main struct NativeProfileSetupChecks {
    static func main() {
        let writes = ["publish", "close", "contact", "create_invite", "accept_invite", "send_message", "request_order", "update_order"]
        for command in writes {
            precondition(NativeProfileSetupGate.requiresSetup(command: command, nameRequired: true, demo: false))
            precondition(!NativeProfileSetupGate.requiresSetup(command: command, nameRequired: false, demo: false))
            precondition(!NativeProfileSetupGate.requiresSetup(command: command, nameRequired: true, demo: true))
        }
        for command in ["update_profile", "save", "archive_order", "set_filter", "load_profile", "continue_search", "set_settings"] {
            precondition(!NativeProfileSetupGate.requiresSetup(command: command, nameRequired: true, demo: false))
        }
        var stack = NativeProfileSheetStack()
        let draft = UUID(), detail = UUID()
        stack.register(draft); stack.register(draft)
        precondition(stack.ids.count == 1)
        stack.register(detail)
        precondition(stack.top == detail)
        stack.unregister(draft)
        precondition(stack.top == detail && stack.ids.count == 1)
        stack.unregister(detail)
        precondition(stack.top == nil && stack.ids.isEmpty)
        print("Native profile setup: command policy and topmost-sheet checks passed")
    }
}
