import SwiftUI

struct ListingDetailView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    let listing: MarketListing
    var onContact: (() -> Void)? = nil
    var onOrder: (() -> Void)? = nil
    @State private var invitation = false
    @State private var authorProfile = false
    @State private var reviewOrder = false
    @State private var orderRequested = false
    private var current: MarketListing { store.snapshot.listings.first(where: { $0.id == listing.id }) ?? listing }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 23) {
                    Group {
                        if let raw = current.imageUrl, let url = URL(string: raw) { AsyncImage(url: url) { phase in if let image = phase.image { image.resizable().scaledToFill() } else { ListingPlaceholder(category: current.category) } } }
                        else { ListingPlaceholder(category: current.category) }
                    }.frame(height: 285).clipped().clipShape(RoundedRectangle(cornerRadius: 28))
                    HStack { Text(current.side == "request" ? "BUYING" : current.category.uppercased()).font(.system(size: 10, weight: .bold)).tracking(1.5).foregroundStyle(MarketTheme.green); Spacer(); Text(current.delivery == "queued" ? "Waiting to send" : current.delivery == "failed" ? "Not sent" : "").font(.caption).foregroundStyle(MarketTheme.muted) }
                    Text(current.title).font(.system(size: 32, weight: .medium, design: .serif)).tracking(-0.7).foregroundStyle(MarketTheme.ink)
                    HStack { Text(current.formattedPrice).font(.system(size: 28, weight: .semibold, design: .rounded)); Spacer(); Label(current.location.isEmpty ? "Anywhere" : current.location, systemImage: "mappin.circle.fill").font(.system(size: 13)).foregroundStyle(MarketTheme.muted) }.foregroundStyle(MarketTheme.ink)
                    Button { authorProfile = true } label: {
                        UserRow(person: store.snapshot.people[current.author] ?? .unnamed(current.author))
                    }.accessibilityIdentifier("listingAuthor")
                    Rectangle().fill(MarketTheme.line).frame(height: 1)
                    Text(current.description).font(.system(size: 16)).lineSpacing(6).foregroundStyle(MarketTheme.ink.opacity(0.90))
                    if let relevance = current.relevance { Label(relevance.reason, systemImage: "sparkles").font(.system(size: 13)).foregroundStyle(MarketTheme.green).padding(15).frame(maxWidth: .infinity, alignment: .leading).background(MarketTheme.mint.opacity(0.4), in: RoundedRectangle(cornerRadius: 16)) }
                    MarketInlineError()
                    if current.mine {
                        Button { store.command(["type": "close", "id": current.id]) { if $0 { dismiss() } } } label: { Text("Mark as unavailable") }.buttonStyle(PrimaryButton())
                    } else if current.side == "offer" {
                        Button { reviewOrder = true } label: { Label("Buy", systemImage: "bag.fill") }
                            .buttonStyle(PrimaryButton()).disabled(store.demo || store.busy || !store.snapshot.messagingReady).accessibilityIdentifier("buyListing")
                        if store.demo { Text("Ordering is unavailable in preview mode.").font(.system(size: 12)).foregroundStyle(MarketTheme.muted) }
                    } else {
                        Button {
                            store.command(["type": "contact", "author": current.author, "listing_id": current.id]) { success in
                                if success { dismiss(); onContact?() }
                            }
                        } label: {
                            if store.busy { ProgressView().tint(MarketTheme.onAction) } else { Label("Private enquiry", systemImage: "bubble.left.fill") }
                        }.buttonStyle(PrimaryButton()).disabled(store.demo || store.busy || !store.snapshot.messagingReady).accessibilityIdentifier("privateEnquiry")
                        Text(store.demo ? "Private enquiries are unavailable in preview mode." : "Your conversation stays private.").font(.system(size: 12)).foregroundStyle(MarketTheme.muted).multilineTextAlignment(.center).frame(maxWidth: .infinity)
                        Button("Connect with an invitation instead") { invitation = true }.font(.system(size: 12)).frame(maxWidth: .infinity)
                    }
                }.padding(23)
            }.background(MarketTheme.paper)
                .sheet(isPresented: $authorProfile) { AuthorProfileView(author: current.author).marketSheetScope() }.navigationTitle("Listing").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button { store.save(current) } label: { Image(systemName: current.saved ? "heart.fill" : "heart") }.accessibilityLabel("Save listing") } }
                .sheet(isPresented: $invitation) { InvitationView().marketSheetScope() }
                .sheet(isPresented: $reviewOrder, onDismiss: { if orderRequested { dismiss(); onOrder?() } }) { OrderReviewView(listing: current) { orderRequested = true }.marketSheetScope() }
        }
    }
}

struct NewListingView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @State private var side = "offer"
    @State private var title = ""
    @State private var description = ""
    @State private var price = ""
    @State private var currency = "EUR"
    @State private var location = ""
    @State private var category = "Other"
    @State private var imageURL = ""
    @FocusState private var entryFocused: Bool
    private let categories = ["Electronics", "Home", "Clothing", "Books", "Transport", "Services", "Garden", "Music", "Other"]
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Listing type", selection: $side) { Text("Selling").tag("offer"); Text("Buying").tag("request") }.pickerStyle(.segmented).accessibilityIdentifier("listingSide")
                    TextField("Title", text: $title, prompt: Text("Title").foregroundColor(MarketTheme.muted)).focused($entryFocused).accessibilityIdentifier("listingTitle")
                    TextField("Description", text: $description, prompt: Text("Description").foregroundColor(MarketTheme.muted), axis: .vertical).lineLimit(4...8).accessibilityIdentifier("listingDescription")
                    Picker("Category", selection: $category) { ForEach(categories, id: \.self) { Text($0) } }
                }
                Section("Details") {
                    HStack { TextField("Price or budget", text: $price, prompt: Text("Price or budget").foregroundColor(MarketTheme.muted)).marketDecimalKeyboard().accessibilityIdentifier("listingPrice"); Picker("Currency", selection: $currency) { Text("EUR").tag("EUR"); Text("USD").tag("USD"); Text("GBP").tag("GBP"); Text("BTC").tag("BTC") }.labelsHidden().frame(width: 90) }
                    TextField("Town, area, or remote", text: $location, prompt: Text("Town, area, or remote").foregroundColor(MarketTheme.muted)).accessibilityIdentifier("listingLocation")
                    TextField("Photo URL (optional)", text: $imageURL, prompt: Text("Photo URL (optional)").foregroundColor(MarketTheme.muted)).marketNoAutocapitalization().autocorrectionDisabled().marketURLKeyboard()
                }
                Section {
                    if store.demo { Label("Preview mode: publishing is turned off.", systemImage: "eye").font(.system(size: 13)).foregroundStyle(MarketTheme.muted) }
                    else if !store.snapshot.canSign { Text("Sign in with your account key to publish listings.").font(.system(size: 13)).foregroundStyle(MarketTheme.muted) }
                    else { Text("Your listing will be public, and people can contact you privately. Keep exact addresses and private contact details out of your listing.").font(.system(size: 13)).foregroundStyle(MarketTheme.muted) }
                    MarketInlineError()
                    Button { publish() } label: { HStack { Spacer(); if store.busy { ProgressView() } else { Text("Publish listing").fontWeight(.semibold) }; Spacer() }.padding(.vertical, 8) }
                        .disabled(store.demo || store.busy || !store.snapshot.canSign || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("publishListing")
                }
            }.scrollContentBackground(.hidden).background(MarketTheme.paper).marketKeyboardDismissal().navigationTitle("New listing").marketInlineTitle()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    #if !os(macOS)
                    ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { entryFocused = false }.accessibilityIdentifier("dismissKeyboard") }
                    #endif
                }
        }
    }
    private func publish() {
        let draft: [String: Any] = ["title": title, "description": description, "side": side, "price": price, "currency": currency, "location": location, "category": category, "image_url": imageURL.isEmpty ? NSNull() : imageURL as Any]
        store.command(["type": "publish", "draft": draft]) { if $0 { dismiss() } }
    }
}
