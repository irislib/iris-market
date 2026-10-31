import SwiftUI

struct MarketReview: Decodable, Identifiable {
    let id: String, author: String, body: String
    let rating: Double, ratingMax: Int, updatedAt: UInt64
    let person: MarketPerson
}
struct ReviewsView: View {
    @EnvironmentObject private var store: MarketStore
    let target: String
    var product = false
    @State private var reviews: [MarketReview] = []
    @State private var loading = false
    @State private var expanded = false
    @State private var writing = false
    @State private var rating = 5
    @State private var bodyText = ""
    @State private var publishing = false
    @State private var failure: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Button { expanded.toggle() } label: {
                    HStack { Text("\(reviews.count) reviews"); if !reviews.isEmpty { Image(systemName: expanded ? "chevron.up" : "chevron.down") } }
                }.buttonStyle(.plain).font(.headline)
                if loading { ProgressView().controlSize(.small) }
                Spacer()
                if !product && target != store.snapshot.publicKey && store.snapshot.canSign && !store.demo {
                    Button(writing ? "Cancel" : "Write a review") { writing.toggle(); expanded = true }.font(.subheadline)
                }
            }
            if writing {
                HStack { ForEach(1...5, id: \.self) { value in Button { rating = value } label: { Image(systemName: value <= rating ? "star.fill" : "star").font(.title2) }.buttonStyle(.plain).accessibilityLabel("\(value) stars") } }
                TextField("Your experience (optional)", text: $bodyText, axis: .vertical).lineLimit(3...6).textFieldStyle(.roundedBorder)
                Text("Your review will be public.").font(.caption).foregroundStyle(MarketTheme.muted)
                if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
                Button(publishing ? "Publishing…" : "Publish review") {
                    publishing = true; failure = nil
                    let owner = store.snapshot.publicKey
                    Task { do { let next = try await store.publishReview(target: target, rating: UInt8(rating), body: bodyText, expectedOwner: owner); guard store.snapshot.publicKey == owner else { return }; reviews = next; writing = false; bodyText = "" } catch is CancellationError { } catch { failure = marketErrorMessage(error) }; publishing = false }
                }.disabled(publishing || bodyText.count > 3000 || store.demo || !store.snapshot.canSign)
            }
            if expanded {
                ForEach(reviews) { review in
                    VStack(alignment: .leading, spacing: 6) {
                        UserRow(person: review.person)
                        if review.ratingMax == 5 { Text(String(repeating: "★", count: Int(review.rating)) + String(repeating: "☆", count: 5 - Int(review.rating))).accessibilityLabel("\(Int(review.rating)) of 5 stars") }
                        else { Text("\(Int((review.rating * 100).rounded()))% positive").font(.caption).foregroundStyle(MarketTheme.muted) }
                        if !review.body.isEmpty { Text(review.body).font(.body).textSelection(.enabled) }
                    }.padding(.vertical, 6)
                }
            }
        }
        .task(id: target + store.snapshot.publicKey) {
            reviews = []; writing = false; bodyText = ""; failure = nil; publishing = false; loading = true
            if let cached = try? await store.loadReviews(target: target, product: product, refresh: false), !Task.isCancelled { reviews = cached }
            guard !Task.isCancelled else { return }
            if let fetched = try? await store.loadReviews(target: target, product: product, refresh: true), !Task.isCancelled { reviews = fetched }
            if !Task.isCancelled { loading = false }
        }
    }
}
