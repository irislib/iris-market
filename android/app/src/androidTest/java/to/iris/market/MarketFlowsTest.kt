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
        compose.onNodeWithContentDescription("AI search").performClick()
        compose.onNodeWithContentDescription("AI search").assertIsOn()
        compose.onNodeWithTag("runAISearch").assertExists()
        compose.onNodeWithContentDescription("Search with AI").assertExists()
        compose.onNode(hasSetTextAction()).assertExists()
        compose.onNodeWithContentDescription("Show map").assertIsNotEnabled()
        compose.onNodeWithContentDescription("AI search").performClick()
    }
    @Test fun compactAISearchStaysInlineAndTextSearchWaitsForSubmit() {
        val search = compose.onNode(hasSetTextAction())
        search.performTextInput("no-such-preview-listing-783")
        compose.onNodeWithText("A little more green").assertExists()
        search.performImeAction()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("No matches").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Clear search").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("A little more green").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("AI search").performClick()
        val action = compose.onNodeWithTag("runAISearch")
        action.assertExists()
        compose.onNodeWithContentDescription("Search with AI").assertExists()
        compose.waitForIdle()
        val fieldBounds = search.fetchSemanticsNode().boundsInRoot
        val actionBounds = action.fetchSemanticsNode().boundsInRoot
        val toggleBounds = compose.onNodeWithContentDescription("AI search").fetchSemanticsNode().boundsInRoot
        println("Compact search bounds: editable=$fieldBounds toggle=$toggleBounds action=$actionBounds")
        capture("compact-ai-search-inline")
        org.junit.Assert.assertTrue("Action must remain inside the search field", actionBounds.left >= fieldBounds.left && actionBounds.right <= fieldBounds.right)
        org.junit.Assert.assertTrue("Action must share the search row", kotlin.math.abs(actionBounds.center.y - toggleBounds.center.y) < 1f)
        org.junit.Assert.assertTrue("Action center must stay within the editable field", actionBounds.center.y >= fieldBounds.top && actionBounds.center.y <= fieldBounds.bottom)
        compose.onNodeWithContentDescription("AI search").performClick()
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
