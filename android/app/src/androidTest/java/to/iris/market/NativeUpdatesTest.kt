package to.iris.market

import android.app.Application
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import org.junit.*
import org.junit.Assert.assertTrue
import java.io.File

class NativeUpdatesTest {
    @get:Rule val compose = createComposeRule()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    @After fun close() { scope.cancel() }

    private fun show(preview: Boolean): NativeUpdates {
        val application = ApplicationProvider.getApplicationContext<Application>()
        val updates = NativeUpdates(application, scope, preview)
        compose.setContent { MaterialTheme { Surface { Column(Modifier.fillMaxWidth().systemBarsPadding().padding(24.dp)) { AppUpdatesView(updates, preview) } } } }
        return updates
    }

    @Test fun previewDoesNotAllowNetworkChecks() {
        show(true)
        compose.onNodeWithText("Check for updates").assertIsNotEnabled()
        compose.onNodeWithText("App updates").assertIsDisplayed()
    }

    @Test fun signedCheckAndFailureAreVisibleWithoutAProfile() {
        // Opt-in production transport acceptance; ordinary suites stay offline.
        Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("marketUpdateLive") == "true")
        val updates = show(false)
        compose.onNodeWithText("Check for updates").performClick()
        compose.waitUntil(45_000) { updates.state.value.checked || updates.state.value.error != null }
        assertTrue(updates.state.value.error, updates.state.value.checked)
        compose.onNodeWithText("Check for updates").assertIsEnabled()
        capture("android-update-checked")
        val application = ApplicationProvider.getApplicationContext<Application>()
        val cache = File(application.filesDir, "updates/state/announcement.json")
        val original = cache.readBytes()
        try {
            cache.writeText("invalid test announcement")
            compose.onNodeWithText("Check for updates").performClick()
            compose.waitUntil(5_000) { updates.state.value.error != null }
            compose.onNodeWithText("Invalid saved update announcement").assertIsDisplayed()
            compose.onNodeWithText("You’re up to date").assertDoesNotExist()
            capture("android-update-error")
        } finally { cache.writeBytes(original) }
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = File(instrumentation.targetContext.getExternalFilesDir(null), "native-evidence").apply { mkdirs() }
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        try { File(directory, "$name.png").outputStream().use { check(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)) } }
        finally { bitmap.recycle() }
    }
}
