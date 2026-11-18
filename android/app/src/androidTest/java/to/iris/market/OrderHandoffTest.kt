package to.iris.market

import android.app.Application
import android.graphics.Bitmap
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

import to.iris.market.core.seedNewProfileRelays

class OrderHandoffTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = "iris-handoff:1:" + "x".repeat(200)

    private fun scanQR(value: String): String {
        val modules = handoffQRModules(value)
        val side = (modules.size + 8) * 4
        val pixels = ByteArray(side * side) { i ->
            val x = i % side / 4 - 4
            val y = i / side / 4 - 4
            if (x in modules.indices && y in modules.indices && modules[y][x]) 0 else -1
        }
        return requireNotNull(CameraQRDecoder().decode(pixels, side, side))
    }

    @Test fun longCodeRoundTripsThroughLocalQR() {
        assertEquals(fixture, handoffQRValue(scanQR(fixture)))
        val ack = "iris-handoff:2:pickup:" + "a".repeat(185)
        val receipt = "iris-pickup-receipt:1:" + "c".repeat(340)
        assertEquals(ack, handoffQRValue(scanQR(ack)))
        assertEquals(receipt, receiptQRValue(scanQR(receipt)))
        assertNull(handoffQRValue(receipt))
        assertNull(receiptQRValue(ack))
        assertNull(receiptQRValue(receipt + "c".repeat(24)))
        assertNull(handoffQRValue("cashuBexample"))
        assertNull(handoffQRValue(fixture + "123456"))
        assertNull(handoffQRValue(fixture + "\n"))
    }

    /** Synchronize a synthetic purchase locally, disconnect both actors, then check the buyer’s QR offline. */
    @Test fun pickupCodeVerifiesOnTheSellersOfflineDevice() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val relay = InstrumentationRegistry.getArguments().getString("handoffRelay")
        assumeTrue(relay != null)
        require(Regex("ws://127\\.0\\.0\\.1:[0-9]+").matches(relay!!))
        val app = instrumentation.targetContext.applicationContext as Application
        val root = kotlin.io.path.createTempDirectory(app.cacheDir.toPath(), "handoff-").toFile()
        val stores = mutableListOf<ViewModelStore>()
        fun actor(name: String): MarketModel {
            val isolated = object : Application() {
                init { attachBaseContext(app) }
                override fun getFilesDir() = File(root, "$name/files").apply { mkdirs() }
                override fun getNoBackupFilesDir() = File(root, "$name/private").apply { mkdirs() }
            }
            seedNewProfileRelays(File(isolated.filesDir, "market").absolutePath, listOf(relay))
            val store = ViewModelStore().also(stores::add)
            val model = ViewModelProvider(store, object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T: ViewModel> create(modelClass: Class<T>): T = MarketModel(isolated, false) as T
            })[MarketModel::class.java]
            compose.waitUntil(30_000) { model.state.value.publicKey.isNotBlank() }
            return model
        }
        fun send(model: MarketModel, request: JSONObject) {
            val result = AtomicReference<String>()
            compose.runOnUiThread { model.orderCommand(request, { result.set("ok") }, { result.set(it) }) }
            compose.waitUntil(30_000) { result.get() != null }
            assertEquals("ok", result.get())
        }
        fun command(type: String) = JSONObject().put("type", type)
        try {
            val buyer = actor("buyer")
            val seller = actor("seller")
            for ((model, name) in listOf(buyer to "Local buyer", seller to "Local seller")) {
                send(model, command("update_profile").put("name", name))
                send(model, command("set_filter").put("query", "").put("side", "offer").put("network_only", false))
            }
            val title = "Pickup item " + java.util.UUID.randomUUID().toString().take(8)
            val draft = JSONObject().put("title", title).put("description", "Local pickup check").put("side", "offer")
                .put("category", "Home").put("price", "6").put("currency", "EUR").put("location", "Sample shop")
            send(seller, command("publish").put("draft", draft))
            compose.waitUntil(45_000) { buyer.state.value.listings.any { it.title == title } }
            val item = buyer.state.value.listings.single { it.title == title }
            send(buyer, command("request_order").put("listing_id", item.id).put("quantity", 1).put("fulfillment", "pickup"))
            val orderId = buyer.state.value.orders.single().id
            compose.waitUntil(60_000) { seller.state.value.orders.any { it.id == orderId } }
            send(seller, command("update_order").put("order_id", orderId).put("patch", JSONObject().put("status", "accepted")))
            compose.waitUntil(60_000) { buyer.state.value.orders.single().handoffs.contains(OrderHandoff("pickup", "show")) }
            assertTrue(seller.state.value.orders.single().handoffs.contains(OrderHandoff("pickup", "scan")))
            for (model in listOf(buyer, seller)) {
                send(model, command("set_settings").put("settings", JSONObject(model.state.value.settings).put("relays", JSONArray())))
                assertEquals(0, JSONObject(model.state.value.settings).getJSONArray("relays").length())
            }
            compose.setContent {
                val snapshot by seller.state.collectAsState()
                MarketTheme(false) {
                    Box(Modifier.fillMaxSize().systemBarsPadding()) { OrderDetail(snapshot.orders.single(), snapshot, seller, false, {}) {} }
                }
            }
            fun capture(name: String) {
                val image = if (name == "scanner") checkNotNull(instrumentation.uiAutomation.takeScreenshot())
                    else compose.onRoot().captureToImage().asAndroidBitmap()
                try {
                    File(app.cacheDir, "handoff-$name.png").outputStream().use { check(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
                } finally { image.recycle() }
            }
            val scan = compose.onNodeWithText("Scan pickup code").performScrollTo().assertIsEnabled()
            if (InstrumentationRegistry.getArguments().getString("handoffCamera") == "true") {
                fun hasCameraFrame(view: View): Boolean = when (view) {
                    is TextureView -> view.isAvailable && (view.surfaceTexture?.timestamp ?: 0L) > 0L
                    is ViewGroup -> (0 until view.childCount).any { hasCameraFrame(view.getChildAt(it)) }
                    else -> false
                }
                scan.performClick()
                compose.onNodeWithText("Place the QR code inside the camera view.").assertIsDisplayed()
                compose.waitUntil(15_000) { compose.runOnIdle { WindowInspector.getGlobalWindowViews().any(::hasCameraFrame) } }
                capture("scanner")
                compose.onNodeWithText("Cancel").performClick()
            }
            runBlocking {
                val code = requireNotNull(buyer.orderHandoff(buyer.state.value.publicKey, orderId, "pickup"))
                val scanned = scanQR(code)
                assertTrue(runCatching { seller.orderHandoff(seller.state.value.publicKey, orderId, "pickup", fixture) }.isFailure)
                assertTrue(seller.state.value.orders.single().handoffs.contains(OrderHandoff("pickup", "scan")))
                seller.orderHandoff(seller.state.value.publicKey, orderId, "pickup", scanned)
            }
            val checked = seller.state.value.orders.single()
            assertTrue(checked.handoffs.contains(OrderHandoff("pickup", "checked")))
            assertEquals("accepted", checked.status)
            assertNull(checked.payment)
            assertNull(checked.pickupReceipt)
            compose.onNodeWithText("Pickup authorization checked on this device.").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("Scan pickup code").assertIsEnabled()
            compose.onNodeWithText("Confirm handover").assertDoesNotExist()
            capture("checked")
            fun pickup(model: MarketModel, request: JSONObject) = runBlocking {
                model.orderHandoffCommand(model.state.value.publicKey, orderId, request)
            }
            val acknowledgment = requireNotNull(pickup(buyer, command("acknowledge_order_pickup")))
            assertEquals("acknowledged", buyer.state.value.orders.single().pickupReceipt?.state)
            pickup(seller, command("verify_order_handoff").put("kind", "pickup").put("pass", handoffQRValue(scanQR(acknowledgment))))
            assertEquals("awaiting-confirmation", seller.state.value.orders.single().pickupReceipt?.state)
            assertNull(seller.state.value.orders.single().pickupReceipt?.confirmedAt)
            compose.onNodeWithText("Confirm handover").performScrollTo().assertIsDisplayed()
            capture("awaiting-confirmation")
            compose.onNodeWithText("Confirm handover").performClick()
            compose.onNodeWithText("Cancel").performClick()
            assertNull(seller.state.value.orders.single().pickupReceipt?.confirmedAt)
            compose.onNodeWithText("Confirm handover").performScrollTo().performClick()
            compose.onNodeWithText("I handed it over").performClick()
            compose.onNodeWithText("Show receipt QR").performScrollTo().assertIsDisplayed()
            capture("confirmed")
            val completed = requireNotNull(pickup(seller, command("show_pickup_receipt")))
            val scanReceipt = command("verify_pickup_receipt").put("receipt", receiptQRValue(scanQR(completed)))
            repeat(2) { pickup(buyer, scanReceipt) }
            val agreed = buyer.state.value.orders.single().pickupReceipt
            assertEquals("confirmed", agreed?.state)
            assertEquals(agreed, seller.state.value.orders.single().pickupReceipt)
            for (model in listOf(buyer, seller)) {
                val unchanged = model.state.value.orders.single()
                assertEquals("accepted", unchanged.status)
                assertNull(unchanged.payment)
            }
        } finally {
            stores.forEach(ViewModelStore::clear)
            root.deleteRecursively()
        }
    }

    @Test fun collectorCanCancelBeforeAcknowledgingAndReadTheReceiptAfterClosure() {
        val fixtureOrder = JSONObject("""{"id":"item","buyer":"buyer","seller":"merchant","items":[],
            "status":"accepted","createdAt":100,"updatedAt":100,"pickupReceiptRole":"collector",
            "shipment":{"stops":[]},"handoffs":[{"kind":"pickup","action":"show"}]}""")
        val original = MarketOrder.parse(fixtureOrder)
        val order = mutableStateOf(original)
        val count = AtomicInteger()
        compose.setContent {
            MarketTheme(false) {
                PickupReceiptSection(order.value, false) { request ->
                    check(request.getString("type") == "acknowledge_order_pickup")
                    count.incrementAndGet()
                    order.value = original.copy(pickupReceipt = PickupReceipt("acknowledged", System.currentTimeMillis() / 1000, null))
                    null
                }
            }
        }
        compose.onNodeWithText("Acknowledge collection").performClick()
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(0, count.get())
        compose.onNodeWithText("Offline pickup options").performClick()
        compose.onNodeWithText("Show authorization code").assertIsEnabled()
        compose.onNodeWithText("Acknowledge collection").performClick()
        compose.onNodeWithText("I collected the item").performClick()
        compose.onNodeWithText("Waiting for merchant confirmation.").assertIsDisplayed()
        compose.onNodeWithText("Scan returned receipt").assertIsEnabled()
        assertEquals(1, count.get())
        compose.runOnIdle { order.value = original.copy(status = "delivered", pickupReceipt = PickupReceipt("confirmed", 101, 105)) }
        compose.onNodeWithText("Merchant confirmed", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Acknowledge collection").assertDoesNotExist()
        compose.onNodeWithText("Scan returned receipt").assertDoesNotExist()
        compose.runOnIdle { order.value = original.copy(pickupReceiptRole = "observer") }
        compose.onNodeWithText("The signed receipt will appear here after pickup.").assertIsDisplayed()
        compose.onNodeWithText("Receive receipt offline").performClick()
        compose.onNodeWithText("Scan returned receipt").assertIsEnabled()
        compose.onNodeWithText("Acknowledge collection").assertDoesNotExist()
        compose.onNodeWithText("Confirm handover").assertDoesNotExist()
    }

    @Test fun codeIsRequestedOnTapAndCanBeRenewed() {
        val issued = AtomicInteger()
        val handoffs = mutableStateOf(listOf(OrderHandoff("pickup", "show"), OrderHandoff("dropoff", "scan")))
        compose.setContent {
            MarketTheme(false) {
                OrderHandoffActions(handoffs.value, false, show = { kind ->
                    check(kind == "pickup"); issued.incrementAndGet(); fixture
                }, verify = { _, _ -> error("No scan expected") })
            }
        }
        compose.onNodeWithText("Scan recipient code").assertIsEnabled()
        assertEquals(0, issued.get())
        compose.onNodeWithText("Show pickup code").performClick()
        fun awaitCode(count: Int) = compose.waitUntil(10_000) {
            issued.get() == count && compose.onAllNodesWithContentDescription("pickup handoff QR code").fetchSemanticsNodes().isNotEmpty()
        }
        awaitCode(1)
        compose.onNodeWithText("Get a fresh code").performClick()
        awaitCode(2)
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithContentDescription("pickup handoff QR code").assertDoesNotExist()
        compose.runOnIdle { handoffs.value = listOf(OrderHandoff("dropoff", "checked")) }
        compose.onNodeWithText("Recipient code checked on this device.").assertIsDisplayed()
        compose.onNodeWithText("Scan recipient code").assertDoesNotExist()
    }
}
