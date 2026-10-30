@main struct NativeMessageDraftChecks {
    static func main() {
        var drafts = NativeMessageDrafts()
        let order = NativeMessageDrafts.Key(account: "buyer", peer: "seller", context: "order:buyer:uuid")
        let general = NativeMessageDrafts.Key(account: "buyer", peer: "seller", context: "general")
        drafts[order] = "Pickup timing question"
        precondition(drafts[general].isEmpty)
        drafts[general] = "General inquiry"
        precondition(drafts[order] == "Pickup timing question", "Leaving and reopening must restore the exact order draft")
        let otherAccount = NativeMessageDrafts.Key(account: "other", peer: "seller", context: order.context)
        let otherPeer = NativeMessageDrafts.Key(account: "buyer", peer: "other seller", context: order.context)
        precondition(drafts[otherAccount].isEmpty && drafts[otherPeer].isEmpty)
        precondition(NativeMessageDrafts.Key(account: "buyer", peer: "seller", context: "*") == general)
        drafts.sent(drafts[order], for: order, success: false)
        precondition(drafts[order] == "Pickup timing question", "A failed send must keep the draft")
        let pending = drafts[order]
        drafts[order] = "Newer edit"
        drafts.sent(pending, for: order, success: true)
        precondition(drafts[order] == "Newer edit", "A late success must preserve newer typing")
        drafts.sent("Newer edit", for: order, success: true)
        precondition(drafts[order].isEmpty && drafts[general] == "General inquiry")
        drafts[otherAccount] = "Other account draft"
        drafts.sent("General inquiry", for: general, success: true)
        precondition(drafts[otherAccount] == "Other account draft", "An older account send cannot clear the active account")
        print("Native message drafts: context/account/peer isolation, reopen, failure, and delayed success checks passed")
    }
}
