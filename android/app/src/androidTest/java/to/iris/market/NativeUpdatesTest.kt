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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class NativeUpdatesTest {
    @get:Rule val compose = createComposeRule()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    @After fun close() { scope.cancel() }

    private fun show(preview: Boolean, service: (() -> UpdateService)? = null): NativeUpdates {
        val application = ApplicationProvider.getApplicationContext<Application>()
        val updates = NativeUpdates(application, scope, preview, service)
        compose.setContent { MaterialTheme { Surface { Column(Modifier.fillMaxWidth().systemBarsPadding().padding(24.dp)) { AppUpdatesView(updates, preview) } } } }
        return updates
    }

    @Test fun previewDoesNotAllowNetworkChecks() {
        show(true)
        compose.onNodeWithText("Check for updates").assertIsNotEnabled()
        compose.onNodeWithText("App updates").assertIsDisplayed()
    }

    /** Offline: a stand-in updater walks the real panel through its steps. */
    @Test fun installShowsProgressThenAPlainErrorWithRetry() {
        val release = CountDownLatch(1)
        var progress: UpdateProgress? = null
        var downloads = 0
        val service = object : UpdateService {
            override fun check() = UpdateResult(true, "0.1.4-alpha.22", null, true)
            override fun download(directory: File): UpdateResult {
                downloads++
                progress = UpdateProgress("downloading", 8_400_000, 19_400_000)
                release.await(30, TimeUnit.SECONDS)
                throw UpdateProblem("The download stopped. Check your connection, then retry.")
            }
            override fun progress() = progress
        }
        val updates = show(false) { service }
        compose.onNodeWithText("Check for updates").performClick()
        compose.waitUntil(5_000) { updates.state.value is UpdateStep.Available }
        compose.onNodeWithText("Version 0.1.4-alpha.22 is available").assertIsDisplayed()
        capture("android-update-available")
        compose.onNodeWithText("Install update").performClick()
        compose.waitUntil(5_000) { updates.state.value is UpdateStep.Downloading }
        compose.onNodeWithText("Downloading… 8.4 MB of 19 MB").assertIsDisplayed()
        compose.onNodeWithText("Check for updates").assertIsNotEnabled()
        capture("android-update-downloading")
        release.countDown()
        compose.waitUntil(5_000) { updates.state.value is UpdateStep.Failed }
        compose.onNodeWithText("The download stopped. Check your connection, then retry.").assertIsDisplayed()
        compose.onNodeWithText("Retry").assertIsEnabled()
        capture("android-update-failed")
        compose.onNodeWithText("Retry").performClick()
        compose.waitUntil(5_000) { updates.state.value is UpdateStep.Failed }
        assertTrue(downloads == 2)
    }

    @Test fun signedCheckIsVisibleWithoutAProfileAndSurvivesADamagedCache() {
        // Opt-in production transport acceptance; ordinary suites stay offline.
        Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("marketUpdateLive") == "true")
        val updates = show(false)
        compose.onNodeWithText("Check for updates").performClick()
        compose.waitUntil(45_000) { !updates.state.value.busy }
        assertTrue(updates.state.value.toString(), updates.state.value is UpdateStep.Available || updates.state.value == UpdateStep.UpToDate)
        compose.onNodeWithText("Check for updates").assertIsEnabled()
        capture("android-update-checked")
        val application = ApplicationProvider.getApplicationContext<Application>()
        val cache = File(application.filesDir, "updates/state/announcement.json")
        cache.writeText("invalid test announcement")
        compose.onNodeWithText("Check for updates").performClick()
        compose.waitUntil(45_000) { !updates.state.value.busy }
        assertTrue(updates.state.value.toString(), updates.state.value !is UpdateStep.Failed)
        assertTrue(cache.readText().startsWith("{"))
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
