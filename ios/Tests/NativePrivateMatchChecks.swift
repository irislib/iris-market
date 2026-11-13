import Foundation

@main struct NativePrivateMatchChecks {
    static func main() throws {
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        // Exactly what the core's matching view sends for an introduced alias chat.
        let raw = #"{"sent":{},"received":{},"pairs":{},"public_leads":{},"interests":{"p1":{"helper":"aa","entry":"e1","summary":"Cargo bike","expires_at":9,"vote":true,"contact":null,"chat":"match:p1","connected":true,"shared_profile":false,"revealed":"bb"}}}"#
        let inbox = try decoder.decode(PrivateMatchInbox.self, from: Data(raw.utf8))
        let interest = try inbox.interests["p1"].unwrap()
        precondition(interest.chat == "match:p1" && interest.contact == nil)
        precondition(interest.connected == true && interest.sharedProfile == false && interest.revealed == "bb")
        // Older cores without alias fields still decode as account introductions.
        let legacy = #"{"sent":{},"received":{},"pairs":{},"public_leads":{},"interests":{"p2":{"summary":"Desk","vote":true,"contact":"cc"}}}"#
        let old = try decoder.decode(PrivateMatchInbox.self, from: Data(legacy.utf8)).interests["p2"].unwrap()
        precondition(old.chat == nil && old.contact == "cc" && old.revealed == nil)
        precondition(isPrivateMatch("match:p1") && !isPrivateMatch(String(repeating: "a", count: 64)))
        print("3 native private match checks passed.")
    }
}
private extension Optional { func unwrap() throws -> Wrapped { guard let self else { throw CocoaError(.coderValueNotFound) }; return self } }
