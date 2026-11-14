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
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import to.iris.market.core.generateSecretKey
import to.iris.market.core.publicKeyForSecret
import to.iris.market.core.seedNewProfileRelays
import java.io.File

/**
 * Opt-in, isolated device test on loopback relays only (use `adb reverse`). A new profile starts
 * on the seeded server, publishes nothing until explicit setup, and a signed-in profile keeps
 * message servers changed in the settings editor across reopen.
 */
class LocalRelayProfileTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun relays(model: MarketModel) = JSONObject(model.state.value.settings).optJSONArray("relays")?.toString()

    @Test fun seededServersAndEditorChangesPersistForSignedInProfile() {
        val args = InstrumentationRegistry.getArguments()
        val first = args.getString("profileRelay")
        assumeTrue(first != null)
        val second = requireNotNull(args.getString("profileRelayNext"))
        listOf(first!!, second).forEach { require(Regex("ws://127\\.0\\.0\\.1:[0-9]+").matches(it)) }
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        val root = kotlin.io.path.createTempDirectory(app.cacheDir.toPath(), "relay-profile-").toFile()
        val isolated = object : Application() {
            init { attachBaseContext(app) }
            override fun getFilesDir() = File(root, "files").apply { mkdirs() }
            override fun getNoBackupFilesDir() = File(root, "private").apply { mkdirs() }
        }
        // Before any core opens: the new profile folder gets only the loopback server.
        assertTrue(seedNewProfileRelays(File(isolated.filesDir, "market").absolutePath, listOf(first)))
        val stores = mutableListOf<ViewModelStore>()
        fun open(): MarketModel {
            val store = ViewModelStore().also(stores::add)
            return ViewModelProvider(store, object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T: ViewModel> create(modelClass: Class<T>): T = MarketModel(isolated, false) as T
            })[MarketModel::class.java]
        }
        val firstList = JSONArray().put(first).toString()
        val secondList = JSONArray().put(second).toString()
        val model = open()
        val settingsOpen = mutableStateOf(false)
        try {
            compose.waitUntil(20_000) { model.state.value.publicKey.isNotBlank() }
            assertEquals(firstList, relays(model))
            assertTrue(model.state.value.profileNameRequired)
            // Explicit setup is the first step that may publish, and only to the seeded server.
            var setUp = false
            compose.runOnUiThread { model.command(JSONObject().put("type", "update_profile").put("name", "Loopback check")) { setUp = true } }
            compose.waitUntil(20_000) { setUp && !model.state.value.profileNameRequired }

            // A profile new to this device inherits the servers chosen here.
            val secret = generateSecretKey()
            val owner = publicKeyForSecret(secret)
            compose.runOnUiThread { model.signIn(secret) {} }
            compose.waitUntil(30_000) { model.state.value.publicKey == owner }
            assertEquals(firstList, relays(model))

            compose.setContent {
                val snapshot by model.state.collectAsState()
                MarketTheme(false) {
                    Box(Modifier.fillMaxSize().systemBarsPadding()) {
                        if (settingsOpen.value) SettingsView(snapshot, model, false) { settingsOpen.value = false }
                    }
                }
            }
            settingsOpen.value = true
            compose.onNodeWithText("Connection details").performScrollTo().performClick()
            compose.onNodeWithText("Message servers", substring = true).performScrollTo().performTextReplacement(second)
            compose.waitUntil(15_000) { relays(model) == secondList }
            settingsOpen.value = false
            compose.waitForIdle()
            assertEquals(secondList, relays(model))
        } finally {
            stores.forEach { it.clear() }
        }
        // Reopening the saved profile keeps the edited servers.
        val reopened = open()
        try {
            compose.waitUntil(20_000) { reopened.state.value.publicKey.isNotBlank() }
            assertEquals(secondList, relays(reopened))
        } finally {
            stores.forEach { it.clear() }
            root.deleteRecursively()
        }
    }
}
