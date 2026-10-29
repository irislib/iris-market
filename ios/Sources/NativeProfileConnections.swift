enum NativeProfileConnections {
    static func ordered(known: [String], followers: [String]) -> [String] {
        var seen = Set<String>()
        return (known + followers).filter { seen.insert($0).inserted }
    }
    static func remaining(total: Int, displayed: Int) -> Int { max(0, total - displayed) }
}
