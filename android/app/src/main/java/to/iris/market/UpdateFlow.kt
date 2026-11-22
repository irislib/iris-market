package to.iris.market

import java.io.File

/** What Settings → App updates shows. Plain Kotlin so JVM tests drive it. */
sealed interface UpdateStep {
    data object Idle : UpdateStep
    data object Checking : UpdateStep
    data object UpToDate : UpdateStep
    data class Available(val version: String) : UpdateStep
    data object Fetching : UpdateStep
    data class Downloading(val downloaded: Long, val total: Long?) : UpdateStep
    data object Verifying : UpdateStep
    data object Opening : UpdateStep
    /** The system installer is open; it reports its own progress. */
    data class Handed(val version: String) : UpdateStep
    data class Updated(val version: String) : UpdateStep
    data class Failed(val message: String, val retry: Retry) : UpdateStep

    enum class Retry { Check, Install }

    val busy: Boolean get() = this is Checking || this is Fetching || this is Downloading || this is Verifying || this is Opening

    val status: String? get() = when (this) {
        Idle, is Failed -> null
        Checking -> "Checking for updates…"
        UpToDate -> "You’re up to date"
        is Available -> "Version $version is available"
        Fetching -> "Getting the update…"
        is Downloading -> if (total != null && total > 0) "Downloading… ${megabytes(downloaded)} of ${megabytes(total)}" else "Downloading…"
        Verifying -> "Verifying the update…"
        Opening -> "Opening the installer…"
        is Handed -> "Confirm the update in the installer to finish."
        is Updated -> "Updated to version $version"
    }

    /** null hides the bar; NaN shows a moving bar of unknown length. */
    val fraction: Float? get() = when (this) {
        is Downloading -> if (total != null && total > 0) (downloaded.toFloat() / total).coerceIn(0f, 1f) else Float.NaN
        Fetching, Verifying, Opening -> Float.NaN
        else -> null
    }

    companion object {
        fun megabytes(bytes: Long): String {
            val value = bytes / 1_000_000.0
            return if (value < 10) String.format(java.util.Locale.ROOT, "%.1f MB", value) else String.format(java.util.Locale.ROOT, "%.0f MB", value)
        }
    }
}

data class UpdateResult(val available: Boolean, val latest: String, val path: String?, val verified: Boolean)
data class UpdateProgress(val stage: String, val downloaded: Long, val total: Long?)

/** The Rust updater; `progress` never blocks while a download runs. */
interface UpdateService {
    fun check(): UpdateResult
    fun download(directory: File): UpdateResult
    fun progress(): UpdateProgress?
}

/** A failure whose message people can act on. */
class UpdateProblem(message: String) : Exception(message)

class UpdatePlatform(
    val version: String,
    val service: () -> UpdateService,
    val downloads: () -> File,
    /** Why this build cannot install, checked before downloading. */
    val installBlocker: () -> String?,
    /** False after asking for the install permission. */
    val mayInstall: () -> Boolean,
    val openInstaller: (File) -> Unit,
    val pending: () -> String?,
    val setPending: (String?) -> Unit,
    val describe: (Throwable) -> String,
    val background: (() -> Unit) -> Unit,
    val main: (() -> Unit) -> Unit,
    /** Runs the action repeatedly on the main thread until the returned stop is called. */
    val poll: (() -> Unit) -> (() -> Unit),
)

class UpdateFlow(private val platform: UpdatePlatform, private val publish: (UpdateStep) -> Unit) {
    var step: UpdateStep = UpdateStep.Idle
        private set(value) { field = value; publish(value) }
    private var service: UpdateService? = null
    private var latest: String? = null
    private var download: File? = null
    private var stopPolling: (() -> Unit)? = null

    init {
        platform.pending()?.let { pending ->
            platform.setPending(null)
            latest = pending
            step = if (pending == platform.version) UpdateStep.Updated(pending)
            else UpdateStep.Failed("The update to version $pending didn’t finish.", UpdateStep.Retry.Install)
        }
    }

    fun check() {
        if (step.busy) return
        download = null
        step = UpdateStep.Checking
        run({ it.check() }) { result, error ->
            step = when {
                error != null -> UpdateStep.Failed(error, UpdateStep.Retry.Check)
                result!!.available -> UpdateStep.Available(result.latest).also { latest = result.latest }
                else -> UpdateStep.UpToDate
            }
        }
    }

    /** One press: download with progress, verify, then hand to the system installer. */
    fun install() {
        if (step.busy) return
        platform.installBlocker()?.let { step = UpdateStep.Failed(it, UpdateStep.Retry.Install); return }
        download?.takeIf { it.isFile }?.let { return handOff(it) }
        val directory = try { platform.downloads() } catch (error: Exception) {
            step = UpdateStep.Failed(platform.describe(error), UpdateStep.Retry.Install); return
        }
        step = UpdateStep.Fetching
        stopPolling = platform.poll(::pollProgress)
        run({ it.download(directory) }) { result, error ->
            stopPolling?.invoke(); stopPolling = null
            when {
                error != null -> step = UpdateStep.Failed(error, UpdateStep.Retry.Install)
                result!!.path == null -> step = if (result.available) UpdateStep.Failed("The update could not be downloaded.", UpdateStep.Retry.Install) else UpdateStep.UpToDate
                else -> {
                    latest = result.latest
                    download = File(result.path)
                    handOff(File(result.path))
                }
            }
        }
    }

    fun retry() {
        val failed = step as? UpdateStep.Failed ?: return
        when (failed.retry) {
            UpdateStep.Retry.Check -> check()
            UpdateStep.Retry.Install -> install()
        }
    }

    /** The app came back while the installer was open: the update did not
     *  happen, since a finished update replaces this process. */
    fun returned() {
        if (step is UpdateStep.Handed) {
            platform.setPending(null)
            step = UpdateStep.Failed("The update wasn’t installed.", UpdateStep.Retry.Install)
        }
    }

    fun pollProgress() {
        val current = service ?: return
        if (!step.busy || step == UpdateStep.Verifying) return
        val progress = current.progress() ?: return
        val next = when (progress.stage) {
            "fetching" -> UpdateStep.Fetching
            "downloading" -> UpdateStep.Downloading(progress.downloaded, progress.total)
            "verifying" -> UpdateStep.Verifying
            else -> return
        }
        if (next != step) step = next
    }

    private fun handOff(file: File) {
        step = UpdateStep.Verifying
        if (!platform.mayInstall()) {
            step = UpdateStep.Failed("Allow Iris Market to install apps, then tap Retry.", UpdateStep.Retry.Install)
            return
        }
        step = UpdateStep.Opening
        try {
            platform.openInstaller(file)
        } catch (error: Exception) {
            download = null
            step = UpdateStep.Failed(if (error is UpdateProblem) error.message!! else "Couldn’t open the installer. Please retry.", UpdateStep.Retry.Install)
            return
        }
        val version = latest ?: ""
        platform.setPending(version)
        step = UpdateStep.Handed(version)
    }

    private fun run(operation: (UpdateService) -> UpdateResult, done: (UpdateResult?, String?) -> Unit) {
        val client = try { service ?: platform.service().also { service = it } } catch (error: Exception) {
            done(null, platform.describe(error)); return
        }
        platform.background {
            val outcome = try {
                val result = operation(client)
                if (!result.verified) throw UpdateProblem("The update could not be verified. It was not installed.")
                result to null
            } catch (error: Exception) { null to platform.describe(error) }
            platform.main { done(outcome.first, outcome.second) }
        }
    }
}
