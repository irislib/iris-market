import Foundation
import CoreGraphics

@main struct NativeMessagePresentationChecks {
    static func main() throws {
        let viewport = CGSize(width: 300, height: 400)
        let frames: [String: CGRect] = ["old": CGRect(x: 0,y: -100,width: 200,height: 50), "visible": CGRect(x: 0,y: 30,width: 200,height: 60), "new": CGRect(x: 0,y: 450,width: 200,height: 60), "edge": CGRect(x: 0,y: 395,width: 200,height: 60), "mine": CGRect(x: 0,y: 90,width: 200,height: 60)]
        let incoming: Set<String> = ["old","visible","new","edge"]
        precondition(NativeMessagePresentation.visibleIncoming(frames: frames, viewport: viewport, incoming: incoming) == ["visible"])
        precondition(NativeMessagePresentation.visibleIncoming(frames: frames, viewport: .zero, incoming: incoming).isEmpty)
        precondition(NativeMessagePresentation.visibleIncoming(frames: ["new": CGRect(x: 0,y: 30,width: 200,height: 60)], viewport: viewport, incoming: incoming) == ["new"])
        precondition(NativeMessagePresentation.delivery("sent") == "Sent")
        precondition(NativeMessagePresentation.delivery("delivered") == "Delivered")
        precondition(NativeMessagePresentation.delivery("seen") == "Seen")
        precondition(NativeMessagePresentation.delivery("queued") != "Sent")
        precondition(NativeMessagePresentation.delivery(nil).isEmpty)
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        let reaction = try decoder.decode(NativeMessageReaction.self, from: Data(#"{"emoji":"👍","count":2,"reacted_by_me":true}"#.utf8))
        precondition(reaction.emoji == "👍" && reaction.count == 2 && reaction.reactedByMe)
        print("9 native message presentation checks passed.")
    }
}
