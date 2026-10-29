package to.iris.market

import android.content.Intent
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assume.assumeTrue
import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class MarketFlowsTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var activity: ActivityScenario<MainActivity>
    @Before fun openPreview() {
        val intent = Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
            .putExtra("demo", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity = ActivityScenario.launch(intent)
        compose.waitUntil(15_000) { compose.onAllNodesWithContentDescription("Filters").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Filters").performClick()
        compose.onNodeWithText("Show all listings").performClick()
        compose.waitUntil(15_000) { compose.onAllNodesWithText("A little more green").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Selling").assertIsSelected()
        compose.onNodeWithText("Everything").assertDoesNotExist()
    }
    @After fun close() { activity.close() }
    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = java.io.File(instrumentation.targetContext.getExternalFilesDir(null), "native-evidence").apply { mkdirs() }
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot()) { "Could not capture native screen" }
        try {
            java.io.File(directory, "$name.png").outputStream().use { output ->
                check(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output))
            }
        } finally { bitmap.recycle() }
    }

    @Test fun searchAndSavedListingStayUsable() {
        compose.onNodeWithText("Preview").assertIsDisplayed()
        if (compose.onAllNodesWithContentDescription("Unsave A little more green").fetchSemanticsNodes().isNotEmpty()) {
            compose.onNodeWithContentDescription("Unsave A little more green").performClick()
            compose.waitForIdle()
        }
        compose.onNodeWithContentDescription("Save A little more green").performClick()
        compose.onNodeWithText("Saved",useUnmergedTree=false).performClick()
        compose.onNodeWithText("A little more green").assertIsDisplayed()
        compose.onNodeWithContentDescription("Unsave A little more green").performClick()
        compose.onNodeWithText("Browse").performClick()
        compose.onNode(hasSetTextAction()).performTextInput("nothing-will-match-this-phrase")
        compose.onNodeWithText("A little more green").assertExists()
        compose.onNode(hasSetTextAction()).performImeAction()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("No matches").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Clear search").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("A little more green").fetchSemanticsNodes().isNotEmpty() }
    }
    @Test fun buyingFilterAndBrowseResetUseTwoClearChoices() {
        compose.onNodeWithText("Buying").performClick().assertIsSelected()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("A ride across town").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("A little more green").assertDoesNotExist()
        capture("buying-request")
        if(compose.onAllNodesWithContentDescription("Unsave A ride across town").fetchSemanticsNodes().isNotEmpty()) compose.onNodeWithContentDescription("Unsave A ride across town").performClick()
        compose.onNodeWithContentDescription("Save A ride across town").performClick()
        compose.onNodeWithText("Saved").performClick()
        compose.onNodeWithText("A ride across town").assertIsDisplayed()
        capture("saved-buying-request")
        compose.onNodeWithContentDescription("Unsave A ride across town").performClick()
        compose.onNodeWithText("Browse").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("A little more green").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Selling").assertIsSelected()
    }
    @Test fun orderHistoryHasClearPurchaseSaleDeliveryViews() {
        compose.onNodeWithText("Orders").performClick()
        compose.onNodeWithText("Purchases").assertIsSelected()
        compose.onNodeWithText("No purchases yet").assertIsDisplayed()
        compose.onNodeWithText("Sales").performClick().assertIsSelected()
        compose.onNodeWithText("No sales yet").assertIsDisplayed()
        compose.onNodeWithText("Deliveries").performClick().assertIsSelected()
        compose.onNodeWithText("Deliveries you handle appear here.").assertIsDisplayed()
        compose.onNodeWithText("Archived").performScrollTo().performClick().assertIsSelected()
        compose.onNodeWithText("Nothing archived").assertIsDisplayed()
    }
    @Test fun creationIsExplicitlyDisabledInPreview() {
        compose.onNodeWithContentDescription("Create listing").performClick()
        compose.onNodeWithText("Title").performTextInput("My reading chair")
        compose.onNodeWithText("Description").performTextInput("A cared-for oak chair.")
        compose.onNodeWithText("Publish listing").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("This is Preview. Switch to your live market to publish a listing.").assertExists()
    }
    @Test fun aiSettingsAndAppearancePersist() {
        compose.onNodeWithText("You").performClick()
        compose.onNodeWithText("Dark").performClick().assertIsSelected()
        activity.recreate()
        compose.onNodeWithText("You").performClick()
        compose.onNodeWithText("Dark").assertIsSelected()
        compose.onNodeWithText("Light").performClick().assertIsSelected()
        compose.onNodeWithText("System").performClick().assertIsSelected()
        compose.onNode(hasText("Settings") and hasClickAction()).performClick()
        compose.onNodeWithText("Interests").assertDoesNotExist()
        compose.onNodeWithText("Save settings").assertDoesNotExist()
        val providerLabels = NativePreferences.providers.map { it.label }
        val providerButton = providerLabels.map { hasText(it) }.reduce { left, right -> left or right }
        compose.onNode(providerButton).performScrollTo().performClick()
        compose.onAllNodesWithText("Groq · free quota").onLast().performClick()
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).performSemanticsAction(SemanticsActions.Dismiss) { dismiss -> dismiss() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Settings").fetchSemanticsNodes().size == 1 }
        compose.onNode(hasText("Settings") and hasClickAction()).performClick()
        compose.onNodeWithText("Groq · free quota").assertExists()
        capture("provider-autosaved")
        compose.onNode(providerButton).performScrollTo().performClick()
        compose.onAllNodesWithText("On device · Gemma 4").onLast().performClick()
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).performSemanticsAction(SemanticsActions.Dismiss) { dismiss -> dismiss() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Settings").fetchSemanticsNodes().size == 1 }
    }
    @Test fun profileAndSharedSearchKeepPreviewOffline() {
        compose.onNodeWithText("A little more green").performClick()
        compose.onNodeWithContentDescription("View author").performScrollTo().performClick()
        compose.onNodeWithText("Known",substring=true).performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Profiles are unavailable in offline preview.").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Done").performClick()
        val sparkle = compose.onNodeWithContentDescription("AI search")
        val previous = sparkle.fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.ToggleableState]
        sparkle.performTouchInput { longClick() }
        compose.onNodeWithText("Settings").assertExists()
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).performSemanticsAction(SemanticsActions.Dismiss) { it() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Settings").fetchSemanticsNodes().isEmpty() }
        org.junit.Assert.assertEquals(previous,sparkle.fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.ToggleableState])
        compose.onNodeWithTag("runAISearch").assertDoesNotExist()
        compose.onNodeWithContentDescription("Show map").assertIsNotEnabled()
    }
    @Test fun sparkleLongPressAndKeyboardSearchStayInline() {
        val search = compose.onNode(hasSetTextAction())
        search.performTextInput("no-such-preview-listing-783")
        compose.onNodeWithText("A little more green").assertExists()
        search.performImeAction()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("No matches").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Clear search").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("A little more green").fetchSemanticsNodes().isNotEmpty() }
        val sparkle = compose.onNodeWithContentDescription("AI search")
        val previous = sparkle.fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.ToggleableState]
        org.junit.Assert.assertEquals("Open AI settings",sparkle.fetchSemanticsNode().config[SemanticsActions.OnLongClick].label)
        sparkle.performTouchInput { longClick() }
        compose.onNodeWithText("Settings").assertExists()
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).performSemanticsAction(SemanticsActions.Dismiss) { it() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Settings").fetchSemanticsNodes().isEmpty() }
        org.junit.Assert.assertEquals(previous,sparkle.fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.ToggleableState])
        // Offline preview cannot run a provider, so a normal tap explains setup rather than pretending On.
        sparkle.performClick()
        compose.onNodeWithText("Settings").assertExists()
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).performSemanticsAction(SemanticsActions.Dismiss) { it() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Settings").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("runAISearch").assertDoesNotExist()
        val fieldBounds = search.fetchSemanticsNode().boundsInRoot
        val bounds = sparkle.fetchSemanticsNode().boundsInRoot
        org.junit.Assert.assertTrue(bounds.left >= fieldBounds.left && bounds.right <= fieldBounds.right)
        org.junit.Assert.assertTrue(kotlin.math.abs(bounds.center.y-fieldBounds.center.y)<1f)
        capture("sparkle-only-search-keyboard-submit")
    }

    @Test fun unavailableOnUsesSettingsAndNormalTapPersistsOff() {
        val sparkle=compose.onNodeWithContentDescription("AI search")
        sparkle.performTouchInput { longClick() }
        val providers=NativePreferences.providers.map { hasText(it.label) }.reduce { left,right -> left or right }
        compose.onNode(providers).performScrollTo().performClick()
        compose.onAllNodesWithText("Groq · free quota").onLast().performClick()
        val enabled=compose.onNodeWithTag("enableAI")
        if(enabled.fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.ToggleableState]!=androidx.compose.ui.state.ToggleableState.On) enabled.performClick()
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).performSemanticsAction(SemanticsActions.Dismiss) { it() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Settings").fetchSemanticsNodes().isEmpty() && sparkle.fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.StateDescription]=="On, unavailable" }
        compose.onNode(hasSetTextAction()).performTextInput("no-such-preview-listing-783")
        compose.onNode(hasSetTextAction()).performImeAction()
        compose.onNodeWithText("Settings").assertExists()
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).performSemanticsAction(SemanticsActions.Dismiss) { it() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Settings").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithText("A little more green").assertExists()
        sparkle.performClick()
        compose.waitUntil(5_000) { sparkle.fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.ToggleableState]==androidx.compose.ui.state.ToggleableState.Off }
        sparkle.performTouchInput { longClick() }
        compose.onNodeWithTag("enableAI").assertIsOff()
        capture("unavailable-on-normal-tap-off")
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss)).performSemanticsAction(SemanticsActions.Dismiss) { it() }
    }

    @Test fun homePhotoDefaultKeepsSearchAndSavedWithoutPhotos() {
        compose.onNodeWithContentDescription("Filters").performClick()
        compose.onNodeWithText("Automatic").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("A little more green").fetchSemanticsNodes().isEmpty() }
        capture("home-photo-default-no-placeholder-tiles")
        compose.onNode(hasSetTextAction()).performTextInput("green")
        compose.onNode(hasSetTextAction()).performImeAction()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("A little more green").fetchSemanticsNodes().isNotEmpty() }
        if(compose.onAllNodesWithContentDescription("Unsave A little more green").fetchSemanticsNodes().isNotEmpty()) compose.onNodeWithContentDescription("Unsave A little more green").performClick()
        compose.onNodeWithContentDescription("Save A little more green").performClick()
        compose.onNodeWithContentDescription("Filters").performClick()
        compose.onNodeWithText("Has photos").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("A little more green").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithText("Saved").performClick()
        compose.onNodeWithText("A little more green").assertExists()
        capture("saved-no-photo-remains-visible")
        compose.onNodeWithContentDescription("Unsave A little more green").performClick()
    }

    @Test fun freshProfileNameEntryDoesNotWaitForRelay() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("freshProfile") == "1")
        activity.close()
        activity=ActivityScenario.launch(Intent(ApplicationProvider.getApplicationContext(),MainActivity::class.java).putExtra("demo",false).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        compose.waitUntil(10_000) { compose.onAllNodesWithText("What should we call you?").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Your name").performTextInput("Kind Lantern")
        compose.onNodeWithText("Continue").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("What should we call you?").fetchSemanticsNodes().isEmpty() }
        activity.recreate()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Browse").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("What should we call you?").assertDoesNotExist()
    }

}
