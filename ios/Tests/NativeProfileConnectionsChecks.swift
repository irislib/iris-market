@main struct NativeProfileConnectionsChecks {
    static func main() {
        precondition(NativeProfileConnections.ordered(known: ["b","a","b"], followers: ["c","a","d"]) == ["b","a","c","d"])
        precondition(NativeProfileConnections.ordered(known: ["a"], followers: []) == ["a"], "Known followers remain visible before a lazy lookup finishes")
        precondition(NativeProfileConnections.ordered(known: [], followers: ["c","c","b"]) == ["c","b"])
        precondition(NativeProfileConnections.ordered(known: [], followers: []).isEmpty)
        precondition(NativeProfileConnections.remaining(total: 12, displayed: 3) == 9)
        precondition(NativeProfileConnections.remaining(total: 3, displayed: 3) == 0)
        precondition(NativeProfileConnections.remaining(total: 0, displayed: 3) == 0)
        print("Native profile connections: 7 known-first/dedup/lazy/count checks passed")
    }
}
