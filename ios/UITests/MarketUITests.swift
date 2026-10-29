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
    }
    private func capture(_ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name
        image.lifetime = .keepAlways
        add(image)
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
        app.buttons["tabAccount"].tap()
        XCTAssertTrue(app.staticTexts["Account"].waitForExistence(timeout: 5))
        app.buttons["aiSettingsRow"].tap()
        XCTAssertTrue(app.navigationBars["AI settings"].waitForExistence(timeout: 5))
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
        app.buttons["tabAccount"].tap()
        XCTAssertTrue(app.segmentedControls["appearancePicker"].buttons["Dark"].isSelected)
        app.buttons["aiSettingsRow"].tap()
        XCTAssertTrue(app.navigationBars["AI settings"].waitForExistence(timeout: 5))
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

    func testValidationErrorAndCurationPreferences() throws {
        app.buttons["tabAccount"].tap()
        app.buttons["aiSettingsRow"].tap()
        XCTAssertTrue(app.switches["enableAI"].waitForExistence(timeout: 5))
        // Reset the preview's saved model so this validation check is repeatable.
        for _ in 0..<4 where !app.textFields["aiModel"].isHittable { app.swipeUp() }
        let modelField = app.textFields["aiModel"]
        if let existing = modelField.value as? String, existing != modelField.placeholderValue, !existing.isEmpty {
            modelField.tap()
            modelField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count) + "\n")
        }
        for _ in 0..<4 where !app.switches["enableAI"].isHittable { app.swipeDown() }
        setSwitch("enableAI", enabled: true)
        for _ in 0..<4 where !app.buttons["saveAISettings"].isHittable || app.buttons["saveAISettings"].frame.maxY > app.frame.maxY - 80 { app.swipeUp() }
        app.buttons["saveAISettings"].tap()
        XCTAssertTrue(app.staticTexts["Choose a model before enabling AI"].firstMatch.waitForExistence(timeout: 5))
        capture("08-validation-error")
        if app.alerts.firstMatch.exists { app.alerts.firstMatch.buttons["OK"].tap() }
        for _ in 0..<4 where !app.textFields["aiModel"].isHittable { app.swipeDown() }
        app.textFields["aiModel"].tap()
        app.textFields["aiModel"].typeText("local-preview-model\n")
        for _ in 0..<4 where !app.switches["curateFeed"].isHittable { app.swipeUp() }
        setSwitch("curateFeed", enabled: true)
        for _ in 0..<3 where !app.buttons["saveAISettings"].isHittable || app.buttons["saveAISettings"].frame.maxY > app.frame.maxY - 80 { app.swipeUp() }
        app.buttons["saveAISettings"].tap()
        XCTAssertTrue(app.staticTexts["Preferences saved"].waitForExistence(timeout: 5))
        capture("09-curation-preferences")
        app.buttons["Done"].tap()
        app.buttons["tabExplore"].tap()
        XCTAssertTrue(app.buttons["aiSearchToggle"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons.matching(identifier: "listingOpen").firstMatch.exists)
        // Unknown relevance remains visible. Preview makes no provider calls.
        app.buttons["tabAccount"].tap()
        app.buttons["aiSettingsRow"].tap()
        setSwitch("enableAI", enabled: false)
        for _ in 0..<4 where !app.buttons["saveAISettings"].isHittable || app.buttons["saveAISettings"].frame.maxY > app.frame.maxY - 80 { app.swipeUp() }
        app.buttons["saveAISettings"].tap()
        XCTAssertTrue(app.staticTexts["Preferences saved"].waitForExistence(timeout: 5))
    }

    func testPublicProfilePreviewAndSharedSearchControls() throws {
        app.buttons.matching(identifier: "listingOpen").firstMatch.tap()
        let author = app.buttons["listingAuthor"]
        for _ in 0..<3 where !author.isHittable { app.swipeUp() }
        author.tap()
        XCTAssertTrue(app.navigationBars["Profile"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["profileListings"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Some connections are unavailable."].exists)
        app.buttons["profileKnown"].tap()
        XCTAssertTrue(app.staticTexts["Some connections are unavailable."].waitForExistence(timeout: 5))
        app.buttons["profileKnown"].tap()
        capture("15-profile-preview")
        app.navigationBars["Profile"].buttons["Done"].tap()
        XCTAssertTrue(app.navigationBars["Listing"].waitForExistence(timeout: 5))
        app.navigationBars["Listing"].buttons["Done"].tap()
        let ai = app.buttons["aiSearchToggle"]
        ai.tap()
        XCTAssertEqual(ai.value as? String, "On")
        XCTAssertTrue(app.textFields["marketSearch"].exists)
        XCTAssertFalse(app.buttons["runAISearch"].isEnabled)
        capture("16-shared-search")
        ai.tap()
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
        XCTAssertTrue(app.buttons["tabAccount"].waitForExistence(timeout: 10))
        app.buttons["tabAccount"].tap()
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

    func testSearchAndRequestFilter() throws {
        let search = app.textFields["marketSearch"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("no-such-preview-listing-783")
        XCTAssertTrue(app.staticTexts["No results"].waitForExistence(timeout: 8))
        app.buttons["Clear search"].tap()
        app.buttons["filterBuying"].tap()
        XCTAssertTrue(app.staticTexts["A ride across town"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["filterBuying"].isSelected)
        XCTAssertFalse(app.staticTexts["A little more green"].exists)
        capture("07-requests")
        app.buttons["tabSaved"].tap()
        app.buttons["tabExplore"].tap()
        XCTAssertTrue(app.staticTexts["A little more green"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["filterSelling"].isSelected)
    }
}
