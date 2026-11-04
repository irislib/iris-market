import SwiftUI

struct MarketRetention: Decodable, Equatable {
    var mode = "follow"
    var seconds: Int64?
    var description: String {
        switch mode {
        case "keep": return "This device keeps sent and received messages."
        case "expire": return "This device deletes sent and received messages after " + chatDuration(seconds) + "."
        default: return "This device follows the conversation timer."
        }
    }
    var label: String {
        switch mode {
        case "keep": return "Keep all messages on this device"
        case "expire": return "Delete all messages on this device after " + chatDuration(seconds)
        default: return "Follow the conversation timer"
        }
    }
}

private let chatUnits: [(String, Int64)] = [("Days",86400), ("Hours",3600), ("Minutes",60), ("Seconds",1)]
private func chatDuration(_ seconds: Int64?) -> String {
    guard let seconds, seconds > 0 else { return "Off" }
    let unit = chatUnits.first { seconds % $0.1 == 0 }!
    let n = seconds / unit.1
    return "\(n) " + (n == 1 ? String(unit.0.lowercased().dropLast()) : unit.0.lowercased())
}

struct ChatTimerControl: View {
    @EnvironmentObject var store: MarketStore
    var peer: String? = nil
    @State private var editing = false
    private var policy: MarketRetention { store.snapshot.chatRetention ?? MarketRetention() }
    private var shared: Int64? { store.snapshot.conversations.first { $0.id == peer }?.timerSeconds }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Button { editing = true } label: {
                Label(peer == nil ? "Message retention" : "Conversation timer · " + chatDuration(shared), systemImage: "timer")
            }.disabled(store.demo || store.busy || (peer != nil && !store.snapshot.messagingReady))
            Text(peer == nil ? policy.label : policy.description + " Each participant can keep their own copies.").font(.caption).foregroundStyle(MarketTheme.muted)
        }
        .sheet(isPresented:$editing) { ChatTimerEditor(peer:peer, policy:policy, shared:shared).environmentObject(store) }
    }
}

private struct ChatTimerEditor: View {
    @EnvironmentObject var store: MarketStore
    @Environment(\.dismiss) var dismiss
    let peer: String?
    @State var mode: String
    @State var amount: String
    @State var unit: Int64
    @State private var owner = ""
    init(peer:String?, policy:MarketRetention, shared:Int64?) {
        self.peer=peer
        let seconds=(peer == nil ? policy.seconds : shared) ?? 86400
        let base=chatUnits.first {seconds % $0.1 == 0}!.1
        _mode=State(initialValue:peer == nil ? policy.mode : shared == nil ? "off" : "expire")
        _unit=State(initialValue:base)
        _amount=State(initialValue:String(seconds/base))
    }
    private var seconds: Int64? {
        guard let n=Int64(amount), n>0, n<=Int64(UInt32.max)/unit else {return nil}
        return n*unit
    }
    var body: some View {
        VStack(alignment:.leading,spacing:14) {
            Text(peer == nil ? "Message retention" : "Conversation timer").font(.headline)
            Text(peer == nil ? "Applies to all sent and received messages in every chat for this profile on this device. Deleted messages cannot be restored." : "This timer applies to new messages for both participants. Each person can keep all messages or choose another duration on their own device.").font(.subheadline)
            Picker(peer == nil ? "On this device" : "Shared timer",selection:$mode){
                if peer == nil {
                    Text("Follow the conversation timer").tag("follow")
                    Text("Keep all messages on this device").tag("keep")
                    Text("Delete all messages on this device after…").tag("expire")
                } else { Text("Off").tag("off");Text("Expire new messages after…").tag("expire") }
            }.pickerStyle(.menu)
            if mode=="expire" { HStack {
                TextField("Duration",text:$amount).textFieldStyle(.roundedBorder)
                Picker("Unit",selection:$unit){ForEach(chatUnits.map(\.1),id:\.self){ n in Text(chatUnits.first{$0.1==n}!.0).tag(n)}}.pickerStyle(.menu)
            }}
            MarketInlineError()
            HStack {
                Button("Cancel"){dismiss()}
                Button("Save") {
                    guard store.snapshot.publicKey == owner else {dismiss();return}
                    var command:[String:Any]
                    if let peer { command=["type":"set_chat_timer","peer_id":peer,"seconds":mode=="expire" ? seconds! as Any : NSNull()] }
                    else {var policy:[String:Any]=["mode":mode];if mode=="expire" {policy["seconds"]=seconds};command=["type":"set_chat_retention","policy":policy]}
                    store.command(command){if $0 {dismiss()}}
                }.disabled(store.busy || (mode=="expire" && seconds==nil))
            }
        }.padding(24).onAppear{owner=store.snapshot.publicKey}
    }
}
