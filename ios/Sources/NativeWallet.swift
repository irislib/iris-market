import Foundation
import SwiftUI
import CryptoKit

struct NativeWalletBalance: Decodable, Identifiable, Sendable {
    let testOnly: Bool?
    var id: String { mint + ":" + unit }
    let mint: String
    let unit: String
    let amount: UInt64
}
struct NativeWalletActivity: Decodable, Identifiable, Sendable {
    let testOnly: Bool?
    let id: String
    let kind: String
    let status: String
    let mint: String
    let amount: UInt64
    let fee: UInt64?
    let createdAt: UInt64
    let operationId: String?
    var title: String { ["top_up": "Top up", "token_send": "Sent token", "token_receive": "Received token", "lightning_payment": "Lightning payment"][kind] ?? "Transfer" }
}
struct NativeWalletSnapshot: Decodable, Sendable {
    var balances: [NativeWalletBalance] = []
    var activity: [NativeWalletActivity] = []
    var warningCount: Int = 0
    var reviewRequired: Bool = false
}
struct NativeWalletPreview: Decodable, Sendable {
    let testOnly: Bool?
    let mint: String
    let amount: UInt64
    let unit: String
}
struct NativeWalletInvoice: Decodable, Sendable {
    let testOnly: Bool?
    var isTest: Bool { testOnly == true || NativeWalletUnits.isTest(mint) }
    let mint: String
    let amount: UInt64
    let invoice: String
    let expiresAt: UInt64
}
struct NativeWalletToken: Decodable, Sendable {
    let testOnly: Bool?
    let mint: String
    let amount: UInt64
    let fee: UInt64
    let operationId: String
    let token: String
}
struct NativeWalletSendReview: Decodable, Sendable {
    let requestId: String
    let mintUrl: String
    let amountSat: UInt64
    let feeSat: UInt64
    let maxTotalSat: UInt64
    let existing: Bool
}
struct NativeWalletLightningReview: Decodable, Sendable {
    let mintUrl: String
    let quoteId: String
    let amountSat: UInt64
    let feeSat: UInt64
    let maxTotalSat: UInt64
    let expiryUnix: UInt64
    let state: String
}
struct NativeWalletLightningResult: Decodable, Sendable {
    let amountSat: UInt64
    let feeSat: UInt64?
    let state: String
}
enum NativeOrderPaymentIdentity {
    static func request(orderID: String, mint: String, amount: String) -> String {
        "order-payment:" + SHA256.hash(data: Data((orderID + "\n" + mint + "\n" + amount).utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
enum NativeWalletUnits {
    static func isTest(_ mint: String) -> Bool { URL(string: mint)?.host == "testnut.cashu.space" || URL(string: mint)?.host == "nofees.testnut.cashu.space" }
    static func amount(_ value: UInt64, mint: String) -> String { value.formatted() + (isTest(mint) ? " test sats" : " sats") }
    static func mintName(_ mint: String) -> String { URL(string: mint)?.host ?? mint }
}

/// All blocking FFI work is serialized off the main actor. Bearer tokens never enter MarketSnapshot.
private actor NativeWalletSession {
    private var wallet: MarketWallet?
    private func decode<T: Decodable>(_ text: String) throws -> T {
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: Data(text.utf8))
    }
    private func opened() throws -> MarketWallet {
        guard let wallet else { throw WalletCredentials.Failure.invalidIdentity }; return wallet
    }
    func open(_ material: WalletCredentials.Material) throws -> NativeWalletSnapshot {
        if wallet == nil { wallet = try MarketWallet(baseDir: material.baseDirectory.path, ownerPublicKey: material.owner, devicePublicKey: material.device, seed: material.seed) }
        return try decode(opened().snapshot(refresh: false))
    }
    func snapshot(refresh: Bool) throws -> NativeWalletSnapshot { try decode(opened().snapshot(refresh: refresh)) }
    func preview(_ token: String) throws -> NativeWalletPreview { try decode(previewCashuToken(token: token)) }
    func receive(_ token: String, mint: String) throws { _ = try opened().receive(token: token, approvedMint: mint) }
    func previewSend(mint: String, amount: UInt64, requestID: String) throws -> NativeWalletSendReview { try decode(opened().previewSend(mint: mint, amount: amount, requestId: requestID)) }
    func sendReviewed(_ review: NativeWalletSendReview) throws -> NativeWalletToken { try decode(opened().sendReviewed(mint: review.mintUrl, amount: review.amountSat, maxFee: review.feeSat, requestId: review.requestId)) }
    func previewLightning(mint: String, invoice: String) throws -> NativeWalletLightningReview { try decode(opened().previewLightning(mint: mint, invoice: invoice)) }
    func payLightning(_ review: NativeWalletLightningReview) throws -> NativeWalletLightningResult { try decode(opened().payLightning(mint: review.mintUrl, quoteId: review.quoteId, maxFee: review.feeSat)) }
    func backup(password: String) throws -> String { try opened().exportBackup(password: password) }
    func backupSeed(backup: String, password: String, owner: String) throws -> String { try nativeWalletBackupSeed(backup: backup, password: password, expectedOwner: owner) }
    func restore(material: WalletCredentials.Material, backup: String, password: String) throws -> NativeWalletSnapshot {
        guard wallet == nil else { throw WalletCredentials.Failure.invalidRecoveryKey }
        try restoreNativeWalletBackup(baseDir: material.baseDirectory.path, ownerPublicKey: material.owner, devicePublicKey: material.device, backup: backup, password: password, savedSeed: material.seed)
        return try open(material)
    }
    func invoice(mint: String, amount: UInt64) throws -> NativeWalletInvoice { try decode(opened().topUp(mint: mint, amount: amount)) }
    func token(_ id: String) throws -> NativeWalletToken { try decode(opened().pendingToken(operationId: id)) }
    func reclaim(mint: String, id: String) throws -> UInt64 { try opened().reclaim(mint: mint, operationId: id) }
    func close() { wallet = nil }
}

@MainActor final class NativeWalletModel: ObservableObject {
    @Published var snapshot = NativeWalletSnapshot()
    @Published var busy = false
    @Published var opened = false
    @Published var error: String?
    @Published var notice: String?
    @Published var preview: NativeWalletPreview?
    @Published var invoice: NativeWalletInvoice?
    @Published var token: NativeWalletToken?
    @Published var sendReview: NativeWalletSendReview?
    @Published var lightningReview: NativeWalletLightningReview?
    @Published var encryptedBackup: String?
    private let session = NativeWalletSession()
    private var epoch = 0
    private var tokenReviewGeneration = 0
    private static let tokenReviewError = "Could not read this Cashu token. Check that you copied the whole token."
    private func run(_ body: @escaping () async throws -> Void) {
        guard !busy else { return }; busy = true; error = nil; let current = epoch
        Task {
            do { try await body() } catch { if current == epoch { self.error = "The wallet could not finish this request. Your saved funds and pending transfers are preserved. Try refreshing before retrying." } }
            if current == epoch { busy = false }
        }
    }
    func open(_ material: WalletCredentials.Material) { run { let current = self.epoch; let value = try await self.session.open(material); guard current == self.epoch else { return }; self.snapshot = value; self.opened = true } }
    func refresh() { run { let current = self.epoch; let value = try await self.session.snapshot(refresh: true); guard current == self.epoch else { return }; self.snapshot = value } }
    func clearTokenReview() {
        tokenReviewGeneration += 1; preview = nil
        if error == Self.tokenReviewError { error = nil }
    }
    func clearActionFeedback() { clearTokenReview(); notice = nil }
    func review(_ value: String) {
        guard !busy else { return }
        clearTokenReview()
        let generation = tokenReviewGeneration
        run {
            let current = self.epoch
            do {
                let preview = try await self.session.preview(value)
                guard current == self.epoch, generation == self.tokenReviewGeneration else { return }
                self.preview = preview
            } catch {
                guard current == self.epoch, generation == self.tokenReviewGeneration else { return }
                self.error = Self.tokenReviewError
            }
        }
    }
    func receive(_ value: String, mint: String) { run { let current = self.epoch; try await self.session.receive(value, mint: mint); let snapshot = try await self.session.snapshot(refresh: false); guard current == self.epoch else { return }; self.snapshot = snapshot; self.preview = nil; self.notice = "Token received." } }
    func reviewSend(mint: String, amount: UInt64, requestID: String) { run { let current = self.epoch; let review = try await self.session.previewSend(mint: mint, amount: amount, requestID: requestID); guard current == self.epoch else { return }; self.sendReview = review } }
    func send(_ review: NativeWalletSendReview) { run { let current = self.epoch; let token = try await self.session.sendReviewed(review); let snapshot = try await self.session.snapshot(refresh: false); guard current == self.epoch else { return }; self.token = token; self.sendReview = nil; self.snapshot = snapshot } }
    func reviewLightning(mint: String, invoice: String) { run { let current = self.epoch; let review = try await self.session.previewLightning(mint: mint, invoice: invoice); guard current == self.epoch else { return }; self.lightningReview = review } }
    func payLightning(_ review: NativeWalletLightningReview) { run { let current = self.epoch; let result = try await self.session.payLightning(review); let snapshot = try await self.session.snapshot(refresh: false); guard current == self.epoch else { return }; self.snapshot = snapshot; self.lightningReview = nil; self.notice = result.state == "paid" ? "Lightning payment confirmed by the mint." : "Lightning payment is pending." } }
    func exportBackup(password: String) { run { let current = self.epoch; let backup = try await self.session.backup(password: password); guard current == self.epoch else { return }; self.encryptedBackup = backup } }
    func restoreBackup(backup: String, password: String, owner: String, material: @escaping (String) throws -> WalletCredentials.Material) { run { let current = self.epoch; let seed = try await self.session.backupSeed(backup: backup, password: password, owner: owner); guard current == self.epoch else { return }; let credentials = try material(seed); let snapshot = try await self.session.restore(material: credentials, backup: backup, password: password); guard current == self.epoch else { return }; self.snapshot = snapshot; self.opened = true; self.notice = "Wallet restored. Stop using the original copy and refresh before spending." } }
    func reviewOrder(material: WalletCredentials.Material, mint: String, amount: UInt64, requestID: String) { run { let current = self.epoch; let snapshot = try await self.session.open(material); let review = try await self.session.previewSend(mint: mint, amount: amount, requestID: requestID); guard current == self.epoch else { return }; self.opened = true; self.snapshot = snapshot; self.sendReview = review } }
    func payOrder(_ review: NativeWalletSendReview, queueToken: @escaping (String) async throws -> Void) { run { let current = self.epoch; let token = try await self.session.sendReviewed(review); guard current == self.epoch else { return }; self.token = token; try await queueToken(token.token); let snapshot = try await self.session.snapshot(refresh: false); guard current == self.epoch else { return }; self.snapshot = snapshot; self.notice = "Payment queued privately. The seller will confirm receipt." } }

    func topUp(mint: String, amount: UInt64) { run { let current = self.epoch; let invoice = try await self.session.invoice(mint: mint, amount: amount); let snapshot = try await self.session.snapshot(refresh: false); guard current == self.epoch else { return }; self.invoice = invoice; self.snapshot = snapshot } }
    func showToken(_ id: String) { run { let current = self.epoch; let token = try await self.session.token(id); guard current == self.epoch else { return }; self.token = token } }
    func reclaim(_ item: NativeWalletActivity) { guard let id = item.operationId else { return }; run { let current = self.epoch; let reclaimed = try await self.session.reclaim(mint: item.mint, id: id); let snapshot = try await self.session.snapshot(refresh: false); guard current == self.epoch else { return }; self.snapshot = snapshot; self.token = nil; self.notice = reclaimed > 0 ? NativeWalletUnits.amount(reclaimed, mint: item.mint) + " reclaimed into this wallet." : "No unredeemed funds were returned. Refresh to check this payment." } }
    func clear() { epoch += 1; busy = false; opened = false; token = nil; invoice = nil; preview = nil; sendReview = nil; lightningReview = nil; encryptedBackup = nil; notice = nil; snapshot = NativeWalletSnapshot(); Task { await session.close() } }
}
