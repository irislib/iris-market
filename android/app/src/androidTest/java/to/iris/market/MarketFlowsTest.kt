package to.iris.market

import android.content.Intent
import androidx.compose.ui.test.*
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
        compose.waitUntil(15_000) { compose.onAllNodesWithText("A little more green").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Selling").assertIsSelected()
        compose.onNodeWithText("Everything").assertDoesNotExist()
    }
    @After fun close() { activity.close() }

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
        compose.waitUntil(5_000) { compose.onAllNodesWithText("No matches").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Clear search").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("A little more green").fetchSemanticsNodes().isNotEmpty() }
    }
    @Test fun buyingFilterAndBrowseResetUseTwoClearChoices() {
        compose.onNodeWithText("Buying").performClick().assertIsSelected()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("A ride across town").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("A little more green").assertDoesNotExist()
        compose.onNodeWithText("Saved").performClick()
        compose.onNodeWithText("Browse").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("A little more green").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Selling").assertIsSelected()
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
        compose.onNodeWithText("Settings").performClick()
        compose.onNodeWithText("When you ask for curation, selected public listing text and your interests are sent to this provider. Private conversations are never included.").assertExists()
        compose.onNodeWithText("Interests").performScrollTo().performTextReplacement("Used furniture and useful weekend work")
        compose.onNodeWithText("Save settings").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Settings").performClick()
        compose.onNodeWithText("Used furniture and useful weekend work").performScrollTo().assertExists()
    }
    @Test fun profileAndSharedSearchKeepPreviewOffline() {
        compose.onNodeWithText("A little more green").performClick()
        compose.onNodeWithContentDescription("View author").performScrollTo().performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Profiles are unavailable in offline preview.").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithContentDescription("AI search").performClick()
        compose.onNodeWithContentDescription("AI search").assertIsOn()
        compose.onNode(hasSetTextAction()).assertExists()
        compose.onNodeWithContentDescription("Show map").assertIsNotEnabled()
        compose.onNodeWithContentDescription("AI search").performClick()
    }
}
