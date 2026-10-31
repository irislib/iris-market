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
        app.buttons["allPhotosFilter"].tap()
        XCTAssertTrue(app.buttons.matching(identifier: "listingOpen").firstMatch.waitForExistence(timeout: 5))
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
        XCTAssertTrue(expiry.label.contains("Never"))
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
        XCTAssertTrue(app.navigationBars["Private invitation"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["inviteInput"].exists)
        XCTAssertFalse(app.buttons["Accept invitation"].isEnabled)
        capture("14-private-invitation")
        app.buttons["Done"].tap()
        app.buttons["tabProfile"].tap()
        XCTAssertTrue(app.staticTexts["Profile"].waitForExistence(timeout: 5))
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
        app.buttons["tabProfile"].tap()
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
        XCTAssertEqual(control.value as? String, expected)
    }

    func testAISandboxInputsStaySeparateFromFeed() throws {
        app.buttons["tabProfile"].tap(); app.buttons["aiSettingsRow"].tap()
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
        app.buttons["tabProfile"].tap(); app.buttons["aiSettingsRow"].tap()
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
        app.buttons["tabProfile"].tap()
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
        let ai = app.buttons["aiSearchToggle"]
        let previous = ai.value as? String
        ai.press(forDuration: 0.7)
        XCTAssertTrue(app.navigationBars["AI search"].waitForExistence(timeout: 5))
        capture("16-sparkle-settings")
        app.buttons["Done"].tap()
        XCTAssertEqual(ai.value as? String, previous)
        XCTAssertFalse(app.buttons["runAISearch"].exists)
    }

    func testSparkleLongPressAndKeyboardSearchStayInline() throws {
        let search = app.textFields["marketSearch"]
        search.tap(); search.typeText("no-such-preview-listing-783")
        XCTAssertFalse(app.staticTexts["No results"].exists)
        search.typeText("\n")
        XCTAssertTrue(app.staticTexts["No results"].waitForExistence(timeout: 5))
        app.buttons["Clear search"].tap()
        XCTAssertTrue(app.buttons.matching(identifier: "listingOpen").firstMatch.waitForExistence(timeout: 5))
        let sparkle = app.buttons["aiSearchToggle"]
        XCTAssertGreaterThanOrEqual(sparkle.frame.minX, 0)
        XCTAssertLessThanOrEqual(sparkle.frame.maxX, app.frame.width)
        XCTAssertLessThan(abs(sparkle.frame.midY - search.frame.midY), 12)
        XCTAssertFalse(app.buttons["runAISearch"].exists)
        let previous = sparkle.value as? String
        sparkle.press(forDuration: 0.7)
        XCTAssertTrue(app.navigationBars["AI search"].waitForExistence(timeout: 5))
        capture("sparkle-long-press-settings")
        app.buttons["Done"].tap()
        XCTAssertEqual(sparkle.value as? String, previous, "Long press must not also toggle AI")
        capture("sparkle-only-search-keyboard-submit")
    }

    func testUnavailableAppleTapShowsAvailabilityWithoutFalseOn() throws {
        let sparkle = app.buttons["aiSearchToggle"]
        sparkle.press(forDuration: 0.7)
        XCTAssertTrue(app.navigationBars["AI search"].waitForExistence(timeout: 5))
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Provider")).firstMatch.tap()
        app.buttons["Apple on-device"].tap()
        let readiness = app.staticTexts["appleAIAvailability"]
        XCTAssertTrue(readiness.waitForExistence(timeout: 5))
        let reason = readiness.label
        XCTAssertFalse(reason.isEmpty)
        setSwitch("enableAI", enabled: false)
        app.buttons["Done"].tap()
        if reason == "Ready on this device" { throw XCTSkip("This runtime has Apple Intelligence; unavailable transition is covered by injected lifecycle checks") }
        XCTAssertEqual(sparkle.value as? String, "Off")
        sparkle.tap()
        XCTAssertTrue(app.navigationBars["AI search"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["appleAIAvailability"].label, reason)
        XCTAssertEqual(app.switches["enableAI"].value as? String, "0")
        capture("apple-unavailable-reason")
        setSwitch("enableAI", enabled: true)
        app.buttons["Done"].tap()
        let onUnavailable = NSPredicate(format: "value == %@", "On, unavailable")
        expectation(for: onUnavailable, evaluatedWith: sparkle); waitForExpectations(timeout: 5)
        let search = app.textFields["marketSearch"]
        search.tap(); search.typeText("no-such-preview-listing-783\n")
        XCTAssertTrue(app.navigationBars["AI search"].waitForExistence(timeout: 5), "Unavailable On must explain setup instead of running literal search")
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons.matching(identifier: "listingOpen").firstMatch.exists, "The unavailable AI submit must not replace results with a literal filter")
        sparkle.tap()
        expectation(for: NSPredicate(format: "value == %@", "Off"), evaluatedWith: sparkle); waitForExpectations(timeout: 5)
        sparkle.press(forDuration: 0.7)
        XCTAssertTrue(app.navigationBars["AI search"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.switches["enableAI"].value as? String, "0", "Normal tap must persist Off even while Apple is unavailable")
        capture("apple-unavailable-tap-off")
        app.buttons["Done"].tap()
    }

    func testHomePhotosDefaultDoesNotHideSearchOrSavedListings() throws {
        app.buttons["listingFilters"].tap(); app.buttons["automaticPhotoFilter"].tap()
        XCTAssertTrue(app.staticTexts["No listings"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons.matching(identifier: "listingOpen").firstMatch.exists)
        capture("home-photo-default-no-placeholder-tiles")
        let search = app.textFields["marketSearch"]
        search.tap(); search.typeText("green\n")
        XCTAssertTrue(app.staticTexts["A little more green"].waitForExistence(timeout: 5))
        let unsave = app.buttons["Unsave A little more green"]
        if unsave.exists { unsave.tap() }
        app.buttons["Save A little more green"].tap()
        app.buttons["listingFilters"].tap(); app.buttons["hasPhotosFilter"].tap()
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
    func testLocalSignInDoesNotWaitForRelay() throws {
        guard ProcessInfo.processInfo.environment["MARKET_LOCAL_SIGNIN_UI_TEST"] == "1" else { throw XCTSkip("Needs the isolated silent local relay") }
        app.terminate(); app.launchArguments = []; app.launch()
        XCTAssertTrue(app.buttons["tabProfile"].waitForExistence(timeout: 10))
        app.buttons["tabProfile"].tap()
        app.buttons["Sign in"].tap()
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
        XCTAssertTrue(app.buttons["tabProfile"].waitForExistence(timeout: 5))
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["tabProfile"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.textFields["profileName"].exists)
        capture("fresh-profile-name-persisted")
    }

}
