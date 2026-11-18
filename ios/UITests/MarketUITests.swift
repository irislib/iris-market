import XCTest

final class MarketUITests: XCTestCase {
    private var app: XCUIApplication!
    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["--demo"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Listings"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["filterSelling"].isSelected)
        XCTAssertFalse(app.buttons["filterAll"].exists)
        // Offline preview fixtures intentionally have no photographs.
        app.buttons["listingFilters"].tap()
        XCTAssertTrue(app.switches["hasPhotosFilter"].waitForExistence(timeout: 5))
        setSwitch("hasPhotosFilter", enabled: false)
        app.buttons["closeListingFilters"].tap()
        XCTAssertTrue(app.buttons.matching(identifier: "listingOpen").firstMatch.waitForExistence(timeout: 5))
    }
    /// Settings live in the main menu rather than a tab.
    private func openSettings() {
        app.descendants(matching: .any).matching(identifier: "mainMenu").firstMatch.tap()
        let settings = app.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5)); settings.tap()
    }
    private func capture(_ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name
        image.lifetime = .keepAlways
        add(image)
    }
    func testRelativeExpiryPresetsStayOptionalInComposer() {
        app.buttons.matching(identifier: "listingOpen").firstMatch.tap()
        XCTAssertTrue(app.staticTexts["listingExpiryDetail"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["listingExpiryDetail"].label, "No expiry")
        app.buttons["Done"].tap()
        app.buttons["createListing"].tap()
        XCTAssertTrue(app.textFields["listingTitle"].waitForExistence(timeout: 5))
        let expiry = app.buttons["listingExpiry"]
        for _ in 0..<3 where !expiry.isHittable { app.swipeUp() }
        XCTAssertTrue(expiry.waitForExistence(timeout: 5))
        // New listings expire after three months unless the poster chooses otherwise.
        XCTAssertTrue(expiry.label.contains("90 days"), expiry.label)
        expiry.tap()
        app.buttons["1 week"].tap()
        XCTAssertTrue(expiry.label.contains("1 week"))
        capture("relative-expiry-week")
        expiry.tap()
        app.buttons["Never"].tap()
        XCTAssertTrue(expiry.label.contains("Never"))
        app.buttons["Cancel"].tap()
    }

    func testPreviewBrowsingAndNativeFlows() throws {
        XCTAssertTrue(app.staticTexts["PREVIEW"].exists)
        let firstListing = app.buttons.matching(identifier: "listingOpen").firstMatch
        XCTAssertTrue(firstListing.waitForExistence(timeout: 10))
        capture("01-explore")
        firstListing.tap()
        XCTAssertTrue(app.navigationBars["Listing"].waitForExistence(timeout: 5))
        capture("02-listing-detail")
        app.buttons["Done"].tap()

        let save = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Save ")).firstMatch
        if save.exists { save.tap() }
        app.buttons["tabSaved"].tap()
        XCTAssertTrue(app.staticTexts["Saved listings"].waitForExistence(timeout: 5))
        capture("03-saved")

        app.buttons["createListing"].tap()
        XCTAssertTrue(app.textFields["listingTitle"].waitForExistence(timeout: 5))
        capture("04-new-listing")
        app.textFields["listingTitle"].tap()
        app.textFields["listingTitle"].typeText("A new home for my bicycle")
        if app.buttons["dismissKeyboard"].exists { app.buttons["dismissKeyboard"].tap() }
        for _ in 0..<3 where !app.buttons["publishListing"].exists { app.swipeUp() }
        XCTAssertTrue(app.buttons["publishListing"].exists)
        XCTAssertFalse(app.buttons["publishListing"].isEnabled)
        app.buttons["Cancel"].tap()

        app.buttons["tabInbox"].tap()
        XCTAssertTrue(app.staticTexts["Inbox"].waitForExistence(timeout: 5))
        capture("05-inbox")
        app.buttons.matching(NSPredicate(format: "label == %@", "Connect with an invitation")).firstMatch.tap()
        XCTAssertTrue(app.navigationBars["New chat"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["inviteInput"].exists)
        XCTAssertFalse(app.buttons["Join chat"].isEnabled)
        capture("14-private-invitation")
        app.buttons["Done"].tap()
        openSettings()
        XCTAssertTrue(app.buttons["aiSettingsRow"].waitForExistence(timeout: 8))
        app.buttons["aiSettingsRow"].tap()
        XCTAssertTrue(app.navigationBars["AI search"].waitForExistence(timeout: 5))
        capture("06-ai-settings")
        app.buttons["Done"].tap()
        let appearance = app.segmentedControls["appearancePicker"]
        XCTAssertTrue(appearance.waitForExistence(timeout: 5))
        XCTAssertTrue(appearance.buttons["System"].isSelected)
        appearance.buttons["Dark"].tap()
        XCTAssertTrue(appearance.buttons["Dark"].isSelected)
        capture("10-account-dark")
        app.buttons["tabExplore"].tap()
        capture("11-listings-dark")
        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["Listings"].waitForExistence(timeout: 15))
        app.buttons["More"].tap()
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.segmentedControls["appearancePicker"].buttons["Dark"].isSelected)
        app.buttons["aiSettingsRow"].tap()
        XCTAssertTrue(app.navigationBars["AI search"].waitForExistence(timeout: 5))
        capture("12-ai-settings-dark")
        app.buttons["Done"].tap()
        app.segmentedControls["appearancePicker"].buttons["Light"].tap()
        capture("13-account-light")
        app.segmentedControls["appearancePicker"].buttons["System"].tap()
    }

    private func setSwitch(_ identifier: String, enabled: Bool) {
        let control = app.switches[identifier]
        let expected = enabled ? "1" : "0"
        if (control.value as? String) != expected {
            control.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        }
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", expected), object: control)
        XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed, identifier)
    }

    func testAISandboxInputsStaySeparateFromFeed() throws {
        openSettings(); app.buttons["aiSettingsRow"].tap()
        XCTAssertTrue(app.navigationBars["AI search"].waitForExistence(timeout: 5))
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Provider")).firstMatch.tap()
        app.buttons["Groq · free quota"].tap()
        let query = app.textFields["aiTestQuery"]
        for _ in 0..<3 where !query.isHittable { app.swipeUp() }
        XCTAssertTrue(query.waitForExistence(timeout: 5))
        XCTAssertEqual(query.value as? String, "bicycle")
        query.tap(); query.typeText(" synthetic")
        XCTAssertNotEqual(query.value as? String, "bicycle")
        for _ in 0..<3 where !app.buttons["aiSandboxTest"].isHittable { app.swipeUp() }
        XCTAssertFalse(app.buttons["aiSandboxTest"].isEnabled, "Remote tests must remain offline in preview")
        capture("ai-sandbox-editable-preview")
        app.buttons["Done"].tap(); app.buttons["aiSettingsRow"].tap()
        for _ in 0..<3 where !app.textFields["aiTestQuery"].isHittable { app.swipeUp() }
        XCTAssertEqual(app.textFields["aiTestQuery"].value as? String, "bicycle", "Test text must not persist with settings")
        app.buttons["Done"].tap(); app.buttons["tabExplore"].tap()
        XCTAssertTrue(app.buttons.matching(identifier: "listingOpen").firstMatch.waitForExistence(timeout: 5))
    }

    func testAppleSandboxActualDecisionPreservesFeed() throws {
        openSettings(); app.buttons["aiSettingsRow"].tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Provider")).firstMatch.tap()
        app.buttons["Apple on-device"].tap()
        let readiness = app.staticTexts["appleAIAvailability"]
        XCTAssertTrue(readiness.waitForExistence(timeout: 5))
        guard readiness.label == "Ready on this device" else { capture("ai-sandbox-apple-unavailable"); throw XCTSkip(readiness.label) }
        setSwitch("enableAI", enabled: false)
        let query = app.textFields["aiTestQuery"]
        query.tap(withNumberOfTaps: 3, numberOfTouches: 1)
        query.typeText("human edible products")
        XCTAssertEqual(query.value as? String, "human edible products")
        let listing = app.textFields["aiTestListing"]
        listing.tap(withNumberOfTaps: 3, numberOfTouches: 1)
        listing.typeText("Fresh apples. Fresh eating apples from our orchard, sold by the kilogram.")
        XCTAssertEqual(listing.value as? String, "Fresh apples. Fresh eating apples from our orchard, sold by the kilogram.")
        let test = app.buttons["aiSandboxTest"]
        for _ in 0..<3 where !test.isHittable { app.swipeUp() }
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: test); waitForExpectations(timeout: 8)
        print("APPLE_SANDBOX_ONE_INFERENCE_START human edible products")
        test.tap()
        let completed = NSPredicate { _, _ in self.app.staticTexts["aiSandboxResult"].exists || self.app.staticTexts["aiSandboxError"].exists }
        expectation(for: completed, evaluatedWith: app); waitForExpectations(timeout: 45)
        let actual = app.staticTexts["aiSandboxResult"].exists ? app.staticTexts["aiSandboxResult"].label : app.staticTexts["aiSandboxError"].label
        print("APPLE_SANDBOX_ACTUAL_RESULT " + actual)
        capture("ai-sandbox-apple-actual-result")
        XCTAssertEqual(app.switches["enableAI"].value as? String, "0", "Testing must preserve feed AI Off")
        app.buttons["Done"].tap(); app.buttons["tabExplore"].tap()
        XCTAssertTrue(app.buttons.matching(identifier: "listingOpen").firstMatch.waitForExistence(timeout: 5), "The sandbox must not filter the feed")
    }

    func testProviderPreferencesAutosaveWithoutCurationControls() throws {
        openSettings()
        app.buttons["aiSettingsRow"].tap()
        XCTAssertTrue(app.navigationBars["AI search"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Save settings"].exists)
        XCTAssertFalse(app.textFields["Interests"].exists)
        let provider = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Provider")).firstMatch
        XCTAssertTrue(provider.waitForExistence(timeout: 5)); provider.tap()
        app.buttons["Groq · free quota"].tap()
        app.buttons["Done"].tap()
        app.buttons["aiSettingsRow"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Groq")).firstMatch.waitForExistence(timeout: 5))
        capture("09-provider-autosaved")
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Provider")).firstMatch.tap()
        app.buttons["Apple on-device"].tap()
        app.buttons["Done"].tap()
    }

    func testPublicProfilePreviewAndSharedSearchControls() throws {
        app.buttons.matching(identifier: "listingOpen").firstMatch.tap()
        let author = app.buttons["listingAuthor"]
        for _ in 0..<3 where !author.isHittable { app.swipeUp() }
        author.tap()
        XCTAssertTrue(app.navigationBars["Profile"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["profileListings"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Some connections are unavailable."].exists)
        XCTAssertFalse(app.buttons["profileKnown"].exists)
        app.buttons["profileFollowers"].tap()
        XCTAssertTrue(app.buttons["profileFollowers"].isSelected)
        XCTAssertFalse(app.staticTexts["Some connections are unavailable."].exists)
        capture("profile-followers-no-known-tab")
        app.buttons["profileFollowers"].tap()
        capture("15-profile-preview")
        app.navigationBars["Profile"].buttons["Done"].tap()
        XCTAssertTrue(app.navigationBars["Listing"].waitForExistence(timeout: 5))
        app.navigationBars["Listing"].buttons["Done"].tap()
        XCTAssertFalse(app.buttons["aiSearchToggle"].exists)
        XCTAssertTrue(app.buttons["listingFilters"].exists)
    }

    func testKeyboardSubmitsSearchWithoutAnAIButton() throws {
        let search = app.textFields["marketSearch"]
        let query = "zzzx"
        search.tap(); search.typeText(query)
        XCTAssertTrue(app.staticTexts["Listings"].exists)
        XCTAssertFalse(app.staticTexts["No results"].exists)
        search.typeText("\n")
        XCTAssertTrue(app.staticTexts["No results"].waitForExistence(timeout: 5))
        search.tap()
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: query.count))
        XCTAssertTrue(app.buttons.matching(identifier: "listingOpen").firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Listings"].exists)
        XCTAssertFalse(app.buttons["aiSearchToggle"].exists)
        capture("search-without-ai-button")
    }

    func testServiceWorkspacesWithAnOfflineProfile() {
        app.terminate()
        app.launchArguments = ["--ui-test-mode", "--test-storage", "iris-market-ui-roles-\(UUID().uuidString.prefix(8))"]
        app.launchEnvironment["MARKET_ESCROW_TEST_RELAY"] = "ws://127.0.0.1:1"
        app.launch()
        XCTAssertTrue(app.staticTexts["0 listings"].waitForExistence(timeout: 15))
        app.buttons["createListing"].tap()
        let name = app.textFields["profileName"]
        XCTAssertTrue(name.waitForExistence(timeout: 8))
        app.buttons["completeProfileName"].tap()

        openSettings()
        let matching = app.switches["Find a match privately"]
        for _ in 0..<6 where !matching.isHittable { app.swipeUp() }
        setSwitch("Escrow", enabled: true)
        setSwitch("Find a match privately", enabled: true)
        app.buttons["Private matches"].tap()
        app.buttons["Helping"].tap()
        XCTAssertTrue(app.staticTexts["Offers and requests shared with you will appear here."].waitForExistence(timeout: 5))
        capture("private-helper-inbox")
        app.buttons["Done"].tap()

        app.buttons["tabOrders"].tap()
        app.buttons["ordersSales"].tap()
        XCTAssertTrue(app.staticTexts["No sales yet"].waitForExistence(timeout: 5))
        app.buttons["ordersEscrow jobs"].tap()
        let offer = app.buttons["Offer escrow services"]
        XCTAssertTrue(offer.waitForExistence(timeout: 5))
        offer.tap()
        XCTAssertTrue(app.textFields["listingTitle"].waitForExistence(timeout: 5))
        capture("escrow-provider-draft")
        app.buttons["Cancel"].tap()

        app.descendants(matching: .any).matching(identifier: "mainMenu").firstMatch.tap()
        app.buttons["Transport"].tap()
        let sections = app.segmentedControls["transportSections"]
        XCTAssertTrue(sections.waitForExistence(timeout: 5))
        sections.buttons["My jobs"].tap()
        XCTAssertTrue(app.staticTexts["No jobs yet"].waitForExistence(timeout: 5))
        sections.buttons["My service"].tap()
        XCTAssertTrue(app.buttons["announceTransport"].waitForExistence(timeout: 5))
        capture("courier-service")
    }

    func testAllResultsKeepsTheQueryWithAnUnavailableModel() throws {
        openSettings()
        app.buttons["aiSettingsRow"].tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Provider")).firstMatch.tap()
        app.buttons["Apple on-device"].tap()
        XCTAssertTrue(app.staticTexts["appleAIAvailability"].exists)
        setSwitch("enableAI", enabled: true)
        app.buttons["Done"].tap()
        app.buttons["tabExplore"].tap()
        let view = app.buttons["resultView"]
        XCTAssertTrue(view.waitForExistence(timeout: 5))
        // A tap during the settings sheet's dismissal can be dropped; the core applies the choice asynchronously.
        let applied = NSPredicate(format: "label == %@", "Show AI selected")
        view.tap()
        if XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: applied, object: view)], timeout: 3) != .completed { view.tap() }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: applied, object: view)], timeout: 5), .completed)
        let search = app.textFields["marketSearch"]
        search.tap(); search.typeText("no-such-preview-listing-783\n")
        XCTAssertTrue(app.staticTexts["No results"].waitForExistence(timeout: 5))
        capture("all-results-text-search")
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["resultView"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.buttons["resultView"].label, "Show AI selected")
    }

    func testHomePhotosDefaultDoesNotHideSearchOrSavedListings() throws {
        // The photo filter narrows search, but never hides a saved listing.
        let search = app.textFields["marketSearch"]
        search.tap(); search.typeText("green\n")
        XCTAssertTrue(app.staticTexts["A little more green"].waitForExistence(timeout: 5))
        let unsave = app.buttons["Unsave A little more green"]
        if unsave.exists { unsave.tap() }
        app.buttons["Save A little more green"].tap()
        app.buttons["listingFilters"].tap()
        let photos = app.switches["hasPhotosFilter"]; XCTAssertTrue(photos.waitForExistence(timeout: 5))
        capture("listing-filters-sheet")
        photos.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap(); app.buttons["closeListingFilters"].tap()
        XCTAssertTrue(app.staticTexts["No results"].waitForExistence(timeout: 5))
        app.buttons["tabSaved"].tap()
        XCTAssertTrue(app.staticTexts["A little more green"].waitForExistence(timeout: 5))
        capture("saved-no-photo-remains-visible")
        app.buttons["Unsave A little more green"].tap()
    }

    /// Opt-in integration against an isolated local relay; never uses public relay defaults.
    /// The release owner seeds this dedicated simulator's store before enabling the test.
    func testLocalRelayOrderJourney() throws {
        guard ProcessInfo.processInfo.environment["MARKET_LOCAL_ORDER_UI_TEST"] == "1" else { throw XCTSkip("Needs the isolated localhost order fixture") }
        app.terminate()
        app.launchArguments = []
        app.launch()
        XCTAssertTrue(app.staticTexts["Same-day parcel delivery"].waitForExistence(timeout: 30))
        XCTAssertFalse(app.staticTexts["PREVIEW"].exists)
        capture("local-01-native-listing")
        app.buttons.matching(identifier: "listingOpen").firstMatch.tap()
        let buy = app.buttons["buyListing"]
        for _ in 0..<4 where !buy.isHittable { app.swipeUp() }
        XCTAssertTrue(buy.isEnabled)
        buy.tap()
        XCTAssertTrue(app.navigationBars["Review order"].waitForExistence(timeout: 5))
        for (label, address) in [("pickup", "Synthetic pickup meeting point"), ("destination", "Synthetic destination meeting point")] {
            let identifier = "deliveryPlaceAddress." + label
            let field = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
            for _ in 0..<4 where !field.isHittable { app.swipeUp() }
            XCTAssertTrue(field.waitForExistence(timeout: 5))
            field.tap()
            field.typeText(address)
        }
        capture("local-02-native-review")
        let request = app.buttons["requestOrder"]
        for _ in 0..<3 where !request.isHittable { app.swipeUp() }
        request.tap()
        XCTAssertTrue(app.staticTexts["Orders"].waitForExistence(timeout: 8))
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Same-day parcel delivery")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        XCTAssertTrue(app.navigationBars["Order"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Accepted"].waitForExistence(timeout: 30))
        capture("local-03-native-accepted-order")
        for _ in 0..<4 where !app.staticTexts["Pickup"].isHittable { app.swipeUp() }
        XCTAssertTrue(app.staticTexts["Pickup"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Handoff"].exists)
        capture("local-04-native-private-route")
    }

    /// The test owner pre-seeds both account stores with a localhost relay that never replies.
    func testExistingProfileRemoteSigner() throws {
        // The dedicated simulator is seeded with an empty store and loopback relays.
        guard let link = ProcessInfo.processInfo.environment["MARKET_LOCAL_SIGNER_FIXTURE"],
              link.contains("127.0.0.1") else { throw XCTSkip("Requires the isolated signer fixture") }
        app.terminate(); app.launchArguments = []; app.launch()
        let create = app.buttons["createListing"]
        XCTAssertTrue(create.waitForExistence(timeout: 15)); create.tap()
        let existing = app.buttons["Existing profile"]
        XCTAssertTrue(existing.waitForExistence(timeout: 12))
        XCTAssertFalse(app.buttons["Remote signer"].exists)
        existing.tap()
        let remote = app.buttons["Remote signer"]
        XCTAssertTrue(remote.waitForExistence(timeout: 10))
        capture("market-existing-profile"); remote.tap()
        let connection = app.secureTextFields["Signer connection link"]
        XCTAssertTrue(connection.waitForExistence(timeout: 8))
        capture("market-remote-signer")
        connection.tap(); connection.typeText(link)
        let connect = app.buttons["Connect signer"]
        XCTAssertTrue(connect.isEnabled); connect.tap()
        XCTAssertTrue(connection.waitForNonExistence(timeout: 30))
        app.terminate(); app.launch()
        XCTAssertTrue(create.waitForExistence(timeout: 15)); create.tap()
        XCTAssertTrue(app.textFields["listingTitle"].waitForExistence(timeout: 10))
    }
    func testLocalSignInDoesNotWaitForRelay() throws {
        guard ProcessInfo.processInfo.environment["MARKET_LOCAL_SIGNIN_UI_TEST"] == "1" else { throw XCTSkip("Needs the isolated silent local relay") }
        app.terminate(); app.launchArguments = []; app.launch()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "mainMenu").firstMatch.waitForExistence(timeout: 10))
        openSettings()
        app.buttons["Use another profile"].tap()
        let key = app.secureTextFields["accountSecret"]
        XCTAssertTrue(key.waitForExistence(timeout: 5))
        key.tap()
        // Public test constant, never a production account credential.
        key.typeText(String(repeating: "1", count: 64))
        app.buttons["accountSignIn"].tap()
        let closed = NSPredicate(format: "exists == false")
        expectation(for: closed, evaluatedWith: app.navigationBars["Sign in"])
        waitForExpectations(timeout: 5)
        app.buttons["tabExplore"].tap()
        XCTAssertTrue(app.textFields["marketSearch"].waitForExistence(timeout: 5))
        capture("local-signin-ready-with-silent-relay")
    }

    /// Opt-in localhost inventory fixture provides one Browse item and sixty author listings.
    func testLocalDatabaseSurvivesRestart() throws {
        guard ProcessInfo.processInfo.environment["MARKET_LOCAL_DATABASE_UI_TEST"] == "1" else { throw XCTSkip("Needs the isolated cached local inventory") }
        app.terminate(); app.launchArguments = []; app.launch()
        XCTAssertTrue(app.staticTexts["Studio collection 00"].waitForExistence(timeout: 20))
        let save = app.buttons.matching(NSPredicate(format: "label == %@", "Save Studio collection 00")).firstMatch
        XCTAssertTrue(save.waitForExistence(timeout: 5)); save.tap()
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["tabSaved"].waitForExistence(timeout: 15))
        app.buttons["tabSaved"].tap()
        XCTAssertTrue(app.staticTexts["Studio collection 00"].waitForExistence(timeout: 8))
        // The encrypted inbox is opened by the real store at each cold launch.
        app.buttons["tabInbox"].tap()
        XCTAssertTrue(app.staticTexts["Inbox"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.alerts.firstMatch.exists)
        capture("database-reopened-inbox")
        app.buttons["tabSaved"].tap()
        let remove = app.buttons.matching(NSPredicate(format: "label == %@", "Unsave Studio collection 00")).firstMatch
        XCTAssertTrue(remove.waitForExistence(timeout: 5)); remove.tap()
    }

    /// Opt-in localhost inventory fixture provides one Browse item and sixty author listings.
    func testLocalAuthorInventoryAndLoadMore() throws {
        guard ProcessInfo.processInfo.environment["MARKET_LOCAL_PROFILE_UI_TEST"] == "1" else { throw XCTSkip("Needs isolated localhost author inventory") }
        app.terminate(); app.launchArguments = []; app.launch()
        XCTAssertTrue(app.staticTexts["Studio collection 00"].waitForExistence(timeout: 20))
        let search = app.textFields["marketSearch"]
        search.tap(); search.typeText("collection 00\n")
        app.buttons.matching(identifier: "listingOpen").firstMatch.tap()
        let author = app.buttons["listingAuthor"]
        for _ in 0..<4 where !author.isHittable { app.swipeUp() }
        author.tap()
        XCTAssertTrue(app.navigationBars["Profile"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Studio collection 01"].waitForExistence(timeout: 12))
        capture("author-01-independent-listings")
        let save = app.buttons.matching(NSPredicate(format: "label == %@", "Save Studio collection 01")).firstMatch
        XCTAssertTrue(save.isHittable); save.tap()
        let more = app.buttons["profileLoadMore"]
        for _ in 0..<30 where !more.isHittable { app.swipeUp() }
        XCTAssertTrue(more.isHittable); more.tap()
        let next = app.staticTexts["Studio collection 48"]
        for _ in 0..<8 where !next.isHittable { app.swipeUp() }
        XCTAssertTrue(next.waitForExistence(timeout: 12))
        capture("author-02-load-more")
        app.navigationBars["Profile"].buttons["Done"].tap()
        app.navigationBars["Listing"].buttons["Done"].tap()
        XCTAssertEqual(search.value as? String, "collection 00")
        XCTAssertTrue(app.buttons["filterSelling"].isSelected)
        app.buttons["tabSaved"].tap()
        XCTAssertTrue(app.staticTexts["Studio collection 01"].waitForExistence(timeout: 8))
        capture("author-03-saved-listing")
    }

    func testSearchAndRequestFilter() throws {
        let search = app.textFields["marketSearch"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("no-such-preview-listing-783")
        XCTAssertFalse(app.staticTexts["No results"].exists)
        search.typeText("\n")
        XCTAssertTrue(app.staticTexts["No results"].waitForExistence(timeout: 8))
        app.buttons["Clear search"].tap()
        app.buttons["filterBuying"].tap()
        XCTAssertTrue(app.staticTexts["A ride across town"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["filterBuying"].isSelected)
        XCTAssertFalse(app.staticTexts["A little more green"].exists)
        capture("07-requests")
        let requestSave = app.buttons["Save A ride across town"]
        let requestUnsave = app.buttons["Unsave A ride across town"]
        if requestUnsave.exists { requestUnsave.tap() }
        XCTAssertTrue(requestSave.waitForExistence(timeout: 5)); requestSave.tap()
        app.buttons["tabSaved"].tap()
        XCTAssertTrue(app.staticTexts["A ride across town"].waitForExistence(timeout: 5))
        app.buttons["Unsave A ride across town"].tap()
        app.buttons["tabExplore"].tap()
        XCTAssertTrue(app.staticTexts["A little more green"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["filterSelling"].isSelected)
    }
    /// Release owner supplies an empty isolated store and a silent local relay.
    func testFreshProfileNameEntryIsLocalFirst() throws {
        guard ProcessInfo.processInfo.environment["MARKET_FRESH_PROFILE_UI_TEST"] == "1" else { throw XCTSkip("Needs an isolated fresh-profile store") }
        app.terminate(); app.launchArguments = []; app.launch()
        XCTAssertTrue(app.textFields["profileName"].waitForExistence(timeout: 10))
        app.textFields["profileName"].tap(); app.textFields["profileName"].typeText("Kind Lantern")
        app.buttons["completeProfileName"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "mainMenu").firstMatch.waitForExistence(timeout: 5))
        app.terminate(); app.launch()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "mainMenu").firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(app.textFields["profileName"].exists)
        capture("fresh-profile-name-persisted")
    }


    /// Opt-in: a fresh isolated profile on a loopback relay that already holds two listings from one seller.
    func testLocalRelayBasketOrdersTwoListingsTogether() throws {
        guard let relay = ProcessInfo.processInfo.environment["MARKET_BASKET_UI_RELAY"], relay.hasPrefix("ws://127.0.0.1:") else { throw XCTSkip("Needs a seeded loopback relay") }
        let first = ProcessInfo.processInfo.environment["MARKET_BASKET_UI_FIRST"] ?? "Wool scarf"
        let second = ProcessInfo.processInfo.environment["MARKET_BASKET_UI_SECOND"] ?? "Wool mittens"
        let escrowFixture = ProcessInfo.processInfo.environment["MARKET_BASKET_UI_ESCROW"] == "1"
        func visitProviderSelection(_ button: XCUIElement, screenshot: String) {
            for _ in 0..<5 where !button.isHittable { app.swipeUp() }
            XCTAssertTrue(button.isHittable)
            button.tap()
            XCTAssertTrue(app.navigationBars["Escrow trade"].waitForExistence(timeout: 10))
            let provider = app.webViews.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "Choose an escrow provider")).firstMatch
            XCTAssertTrue(provider.waitForExistence(timeout: 10))
            capture(screenshot)
            app.navigationBars["Escrow trade"].buttons["Done"].tap()
            XCTAssertTrue(app.navigationBars["Review order"].waitForExistence(timeout: 5))
        }
        app.terminate()
        app.launchArguments = ["--ui-test-mode", "--test-storage", "iris-market-ui-basket-\(UUID().uuidString.prefix(8))"]
        app.launchEnvironment["MARKET_ESCROW_TEST_RELAY"] = relay
        app.launch()
        let name = app.textFields["profileName"]
        if name.waitForExistence(timeout: 10) { name.tap(); name.typeText("Grandma Test"); app.buttons["completeProfileName"].tap() }
        // The seeded listings have no photos and the fresh profile follows nobody yet.
        XCTAssertTrue(app.buttons["listingFilters"].waitForExistence(timeout: 20))
        app.buttons["listingFilters"].tap()
        XCTAssertTrue(app.switches["hasPhotosFilter"].waitForExistence(timeout: 5))
        setSwitch("hasPhotosFilter", enabled: false)
        app.buttons["closeListingFilters"].tap()
        let everyone = app.buttons["Show everyone"]
        for _ in 0..<6 where !app.buttons["View \(first)"].waitForExistence(timeout: 5) {
            if everyone.exists && everyone.isHittable { everyone.tap() }
        }
        capture("basket-00-feed")
        for title in [first, second] {
            let card = app.buttons["View \(title)"]
            for _ in 0..<6 where !card.waitForExistence(timeout: 5) { app.swipeUp() }
            XCTAssertTrue(card.exists, "\(title) arrives from the relay")
            card.tap()
            if escrowFixture && title == first {
                let protected = app.buttons["buyWithEscrow"]
                for _ in 0..<5 where !protected.isHittable { app.swipeUp() }
                XCTAssertTrue(protected.isHittable)
                protected.tap()
                XCTAssertTrue(app.navigationBars["Review order"].waitForExistence(timeout: 5))
                let choose = app.buttons["requestOrder"]
                XCTAssertEqual(choose.label, "Enable escrow and choose provider")
                visitProviderSelection(choose, screenshot: "basket-01-listing-escrow")
                app.navigationBars["Review order"].buttons["Cancel"].tap()
            }
            let add = app.buttons["addToBasket"]
            for _ in 0..<4 where !add.isHittable { app.swipeUp() }
            XCTAssertTrue(add.waitForExistence(timeout: 5))
            add.tap()
            XCTAssertTrue(app.buttons["viewBasket"].waitForExistence(timeout: 5))
            capture("basket-01-added-\(title)")
            if title == first { app.buttons["Done"].firstMatch.tap() }
        }
        app.buttons["viewBasket"].tap()
        XCTAssertTrue(app.staticTexts["Basket"].waitForExistence(timeout: 8))
        app.buttons["One more \(second)"].tap()
        XCTAssertTrue(app.staticTexts["Total"].waitForExistence(timeout: 5))
        capture("basket-02-orders-basket")
        app.buttons["basketRequestOrder"].tap()
        XCTAssertTrue(app.navigationBars["Review order"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["3 items"].exists)
        if escrowFixture {
            let line = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "basketEscrow.")).firstMatch
            XCTAssertEqual(line.label, "Order this item with escrow")
            visitProviderSelection(line, screenshot: "basket-03-line-escrow")
            XCTAssertTrue(app.staticTexts["3 items"].exists)
        }
        let fulfillment = app.buttons["orderFulfillment"]
        XCTAssertTrue(fulfillment.waitForExistence(timeout: 5))
        XCTAssertTrue(fulfillment.label.contains("Seller arranges delivery") || (fulfillment.value as? String) == "Seller arranges delivery")
        fulfillment.tap()
        app.buttons["I’ll arrange my own delivery"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Booking here shares your destination")).firstMatch.exists)
        fulfillment.tap()
        app.buttons["Pickup"].tap()
        capture("basket-03-review")
        app.buttons["requestBasketOrder"].tap()
        // A first order asks for a name, then the buyer confirms again.
        let nameField = app.textFields["profileName"]
        if nameField.waitForExistence(timeout: 5) {
            nameField.tap(); nameField.typeText("Grandma Test")
            app.buttons["completeProfileName"].tap()
            XCTAssertTrue(app.buttons["requestBasketOrder"].waitForExistence(timeout: 5))
            app.buttons["requestBasketOrder"].tap()
        }
        XCTAssertTrue(app.navigationBars["Order"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Total"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["2 × \(second)"].exists)
        let pickup = app.staticTexts["Pickup"]
        for _ in 0..<4 where !pickup.isHittable { app.swipeUp() }
        XCTAssertTrue(pickup.exists)
        XCTAssertFalse(app.buttons["buyerBookCourier"].exists)
        capture("basket-04-order-detail")
    }
}
