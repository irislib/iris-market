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
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.io.File
import java.util.UUID
import to.iris.market.core.MarketUpdater
import to.iris.market.core.MarketException

/** The Rust updater behind [UpdateService]; replies are JSON. */
private class RustUpdates(dataDir: String, version: String) : UpdateService {
    private val updater = MarketUpdater(dataDir, version)
    override fun check() = parse(updater.check())
    override fun download(directory: File) = parse(updater.download(directory.path))
    override fun progress(): UpdateProgress? = runCatching {
        val value = JSONObject(updater.progress())
        UpdateProgress(value.getString("stage"), value.getLong("downloaded"), if (value.isNull("total")) null else value.getLong("total"))
    }.getOrNull()
    private fun parse(json: String) = JSONObject(json).let {
        UpdateResult(it.getBoolean("available"), it.getString("latest_version"), if (it.isNull("path")) null else it.getString("path"), it.getBoolean("verified"))
    }
}

class NativeUpdates(private val application: Application, private val scope: CoroutineScope, private val preview: Boolean, service: (() -> UpdateService)? = null) {
    private val preferences = application.getSharedPreferences("market_updates", 0)
    private val mutable = MutableStateFlow<UpdateStep>(UpdateStep.Idle)
    val state: StateFlow<UpdateStep> = mutable.asStateFlow()
    private val auto = MutableStateFlow(preferences.getBoolean("automatic", !BuildConfig.DEBUG))
    val automatic = auto.asStateFlow()
    val version: String = BuildConfig.VERSION_NAME
    private val downloads = File(application.filesDir, "updates/downloads")
    val flow = UpdateFlow(UpdatePlatform(
        version = version.removeSuffix("-dev"),
        service = service ?: { RustUpdates(File(application.filesDir, "updates/state").path, version.removeSuffix("-dev")) },
        downloads = { File(downloads, UUID.randomUUID().toString()) },
        // Debug and store builds must not replace a differently signed app.
        installBlocker = { if (BuildConfig.DEBUG && service == null) "Development builds can’t install updates. Use the released app." else null },
        mayInstall = ::mayInstall,
        openInstaller = ::openInstaller,
        pending = { preferences.getString("pendingVersion", null) },
        setPending = { preferences.edit().apply { if (it == null) remove("pendingVersion") else putString("pendingVersion", it) }.apply() },
        describe = { error -> (error as? MarketException.Operation)?.reason ?: error.message ?: "The update stopped unexpectedly. Please retry." },
        background = { work -> scope.launch(Dispatchers.IO) { work() } },
        main = { work -> scope.launch(Dispatchers.Main.immediate) { work() } },
        poll = { action ->
            val job = scope.launch(Dispatchers.Main.immediate) { while (isActive) { delay(200); action() } }
            ({ job.cancel() })
        },
    )) { mutable.value = it }

    fun setAutomatic(value: Boolean) { auto.value = value; preferences.edit().putBoolean("automatic", value).apply() }
    fun checkIfDue() {
        flow.returned()
        if (!preview && auto.value && !flow.step.busy && System.currentTimeMillis() - preferences.getLong("lastAttempt", 0L) >= 86_400_000L) check()
    }
    fun check() {
        if (preview) return
        preferences.edit().putLong("lastAttempt", System.currentTimeMillis()).apply()
        flow.check()
    }
    fun install() { if (!preview) flow.install() }
    fun retry() { if (!preview) flow.retry() }

    private fun mayInstall(): Boolean {
        if (application.packageManager.canRequestPackageInstalls()) return true
        application.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${application.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return false
    }

    private fun openInstaller(file: File) {
        if (!(file.isFile && file.canonicalFile.toPath().startsWith(downloads.canonicalFile.toPath()))) throw UpdateProblem("The downloaded update is missing. Retry to download it again.")
        val uri = FileProvider.getUriForFile(application, "${application.packageName}.updates", file)
        application.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

@Composable fun AppUpdatesView(updates: NativeUpdates, preview: Boolean) {
    val step by updates.state.collectAsState()
    val automatic by updates.automatic.collectAsState()
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("App updates", style = MaterialTheme.typography.titleMedium)
        Text("Version ${updates.version}", color = Muted, style = MaterialTheme.typography.bodySmall)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("Check automatically", Modifier.weight(1f))
            Switch(checked = automatic, enabled = !preview, onCheckedChange = updates::setAutomatic)
        }
        step.status?.let { Text(it) }
        step.fraction?.let { fraction ->
            if (fraction.isNaN()) LinearProgressIndicator(Modifier.fillMaxWidth())
            else LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth())
        }
        (step as? UpdateStep.Failed)?.let { Text(it.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            when (step) {
                is UpdateStep.Available -> Button(onClick = updates::install, enabled = !preview) { Text("Install update") }
                is UpdateStep.Failed -> Button(onClick = updates::retry, enabled = !preview) { Text("Retry") }
                else -> {}
            }
            OutlinedButton(onClick = updates::check, enabled = !preview && !step.busy) { Text("Check for updates") }
        }
    }
}
