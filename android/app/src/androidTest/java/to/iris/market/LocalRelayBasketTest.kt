package to.iris.market

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import to.iris.market.core.seedNewProfileRelays
import java.io.File

/**
 * Opt-in device test on a loopback relay (use `adb reverse`) that already holds two priced
 * listings from one seller: both go into the basket and leave as one order.
 */
class LocalRelayBasketTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun twoListingsFromOneSellerBecomeOneOrder() {
        val args = InstrumentationRegistry.getArguments()
        val relay = args.getString("basketRelay")
        assumeTrue(relay != null)
        require(Regex("ws://127\\.0\\.0\\.1:[0-9]+").matches(relay!!))
        val first = args.getString("basketFirst") ?: "Wool scarf"
        val second = args.getString("basketSecond") ?: "Wool mittens"
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        val root = kotlin.io.path.createTempDirectory(app.cacheDir.toPath(), "basket-").toFile()
        val isolated = object : Application() {
            init { attachBaseContext(app) }
            override fun getFilesDir() = File(root, "files").apply { mkdirs() }
            override fun getNoBackupFilesDir() = File(root, "private").apply { mkdirs() }
        }
        seedNewProfileRelays(File(isolated.filesDir, "market").absolutePath, listOf(relay))
        val store = ViewModelStore()
        val model = ViewModelProvider(store, object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T: ViewModel> create(modelClass: Class<T>): T = MarketModel(isolated, false) as T
        })[MarketModel::class.java]
        val screen = mutableStateOf<Listing?>(null)
        // Screenshots for visual review stay in this app's private cache.
        fun capture(name: String) = File(app.cacheDir, "basket-$name.png").outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        var opened: String? = null
        try {
            compose.waitUntil(20_000) { model.state.value.publicKey.isNotBlank() }
            var ready = false
            compose.runOnUiThread {
                model.command(JSONObject().put("type", "update_profile").put("name", "Grandma Check")) {
                    model.command(JSONObject().put("type", "set_filter").put("query", "").put("side", "offer").put("network_only", false)) { ready = true }
                }
            }
            compose.waitUntil(20_000) { ready }
            fun listing(title: String) = model.state.value.listings.firstOrNull { it.title == title }
            compose.waitUntil(45_000) { listing(first) != null && listing(second) != null }
            compose.setContent {
                val snapshot by model.state.collectAsState()
                MarketTheme(false) {
                    Box(Modifier.fillMaxSize().systemBarsPadding()) {
                        val shown = screen.value
                        if (shown != null) ListingDetail(shown, false, model, false, null, {}, {}, {}, viewBasket = { screen.value = null })
                        else OrdersView(snapshot, model, false) { opened = it }
                    }
                }
            }
            for (title in listOf(first, second)) {
                screen.value = listing(title)
                compose.onNodeWithText("Add to basket").performScrollTo().performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithText("In basket · View basket").fetchSemanticsNodes().isNotEmpty() }
            }
            capture("listing")
            compose.onNodeWithText("In basket · View basket").performScrollTo().performClick()
            compose.onNodeWithText("Basket").assertExists()
            compose.onNodeWithContentDescription("One more $second").performClick()
            compose.waitUntil(10_000) { model.state.value.basket.singleOrNull()?.count == 3 }
            compose.onNodeWithText("Total").assertExists()
            capture("orders")
            compose.onNodeWithText("Request order").performClick()
            compose.onNodeWithText("3 items").assertExists()
            args.getString("basketEscrowListing")?.let { title ->
                compose.onNodeWithText("Use escrow for $title").performScrollTo().performClick()
                compose.onNodeWithText("Review escrow order").assertExists()
                compose.onNodeWithText("Quantity · 2").assertExists()
                compose.onNodeWithText("Enable escrow and choose provider").performScrollTo().assertIsEnabled()
                compose.onNodeWithText("Cancel").performScrollTo().performClick()
                compose.onNodeWithText("3 items").assertExists()
                assertEquals(3, model.state.value.basket.single().count)
            }
            compose.onNodeWithText("Pickup").performScrollTo().performClick().assertIsSelected()
            compose.onAllNodesWithText("Request order").filterToOne(hasClickAction() and hasAnyAncestor(isDialog())).performClick()
            compose.waitUntil(20_000) { opened != null }
            val order = model.state.value.orders.single { it.id == opened }
            assertEquals(listOf(first to 1, second to 2), order.items.map { it.title to it.quantity })
            assertEquals("pickup", order.fulfillment)
            assertEquals(emptyList<BasketGroup>(), model.state.value.basket)
        } finally {
            store.clear()
            root.deleteRecursively()
        }
    }
}
