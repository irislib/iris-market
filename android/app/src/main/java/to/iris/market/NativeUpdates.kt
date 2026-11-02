package to.iris.market

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.io.File
import java.util.UUID
import to.iris.market.core.MarketUpdater
import to.iris.market.core.MarketException

data class NativeUpdateState(
    val busy: Boolean = false, val downloading: Boolean = false,
    val checked: Boolean = false, val available: Boolean = false,
    val latest: String = "", val path: String? = null, val error: String? = null
)

class NativeUpdates(private val application: Application, private val scope: CoroutineScope, private val preview: Boolean) {
    private val preferences = application.getSharedPreferences("market_updates", 0)
    private val mutable = MutableStateFlow(NativeUpdateState())
    val state = mutable.asStateFlow()
    private val auto = MutableStateFlow(preferences.getBoolean("automatic", !BuildConfig.DEBUG))
    val automatic = auto.asStateFlow()
    private val updater by lazy { MarketUpdater(File(application.filesDir, "updates/state").path, BuildConfig.VERSION_NAME.removeSuffix("-dev")) }

    fun setAutomatic(value: Boolean) { auto.value = value; preferences.edit().putBoolean("automatic", value).apply() }
    fun checkIfDue() {
        if (!preview && auto.value && System.currentTimeMillis() - preferences.getLong("lastAttempt", 0L) >= 86_400_000L) check()
    }
    fun check() {
        if (preview || mutable.value.busy) return
        preferences.edit().putLong("lastAttempt", System.currentTimeMillis()).apply()
        mutable.value = NativeUpdateState(busy = true)
        perform { updater.check() }
    }
    fun download() {
        if (preview || mutable.value.busy || !mutable.value.available) return
        mutable.value = mutable.value.copy(busy = true, downloading = true, error = null)
        perform { updater.download(File(application.filesDir, "updates/downloads/${UUID.randomUUID()}").path) }
    }
    private fun perform(operation: () -> String) {
        scope.launch {
            try {
                val result = withContext(Dispatchers.IO) { JSONObject(operation()) }
                kotlin.check(result.getBoolean("verified")) { "The update could not be verified" }
                mutable.value = NativeUpdateState(checked = true, available = result.getBoolean("available"), latest = result.getString("latest_version"), path = if (result.isNull("path")) null else result.getString("path"))
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutable.value = mutable.value.copy(busy = false, downloading = false, error = if (error is MarketException.Operation) error.reason else error.message ?: "Update failed. Try again.") }
        }
    }
    fun install() {
        val path = mutable.value.path ?: return
        try {
            // Debug and store builds must not replace a differently signed app.
            kotlin.check(!BuildConfig.DEBUG) { "Install updates from the release app." }
            if (!application.packageManager.canRequestPackageInstalls()) {
                application.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${application.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                mutable.value = mutable.value.copy(error = "Allow app installs, then tap Install update again.")
                return
            }
            val file = File(path)
            kotlin.check(file.isFile && file.canonicalFile.toPath().startsWith(File(application.filesDir, "updates/downloads").canonicalFile.toPath())) { "The downloaded update is missing. Download it again." }
            val uri = FileProvider.getUriForFile(application, "${application.packageName}.updates", file)
            application.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
            mutable.value = mutable.value.copy(error = null)
        } catch (error: Exception) { mutable.value = mutable.value.copy(error = error.message ?: "Could not open the installer.") }
    }
}

@Composable fun AppUpdatesView(updates: NativeUpdates, preview: Boolean) {
    val state by updates.state.collectAsState()
    val automatic by updates.automatic.collectAsState()
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("App updates", style = MaterialTheme.typography.titleMedium)
        Text("Version ${BuildConfig.VERSION_NAME}", color = Muted, style = MaterialTheme.typography.bodySmall)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("Check automatically", Modifier.weight(1f))
            Switch(checked = automatic, enabled = !preview, onCheckedChange = updates::setAutomatic)
        }
        if (state.busy) {
            Text(if (state.downloading) "Downloading update…" else "Checking for updates…")
        } else if (state.checked) {
            Text(if (state.path != null) "Update ready to install" else if (state.available) "Version ${state.latest} is available" else "You’re up to date")
            if (state.path != null) Button(onClick = updates::install, enabled = !BuildConfig.DEBUG) { Text("Install update") }
            else if (state.available) Button(onClick = updates::download) { Text("Download update") }
        }
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        OutlinedButton(onClick = updates::check, enabled = !preview && !state.busy) { Text("Check for updates") }
    }
}
