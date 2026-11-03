package to.iris.market

import android.app.Application
import android.system.Os
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

internal object CompactSearchFiles {
    const val PROVIDER = "compact"
    const val ID = "market-deberta-xsmall"
    const val REVISION = "2a4f614a701367a02d51389039afc998faeda637"

    data class Asset(val path: String, val bytes: Long, val hash: String) {
        val name get() = path.substringAfterLast('/')
        val url get() = URL("https://huggingface.co/Xenova/nli-deberta-v3-xsmall/resolve/$REVISION/$path")
    }

    val assets = listOf(
        Asset("onnx/model_quantized.onnx", 87_246_587, "3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6"),
        Asset("tokenizer.json", 8_656_551, "a86f883318afa11c8c10466f1bf4efaeb6ded28a52cbe57217a8fa0d0a2a87df"),
        Asset("tokenizer_config.json", 384, "d8d3bb123b99317634d5ee3d1d2d8b2ddb01510a0654687fc2639a5347a7291f"),
        Asset("config.json", 1_038, "ec0bd14cc28640326474399cd61d38ccd52b64900228799d0f81debda8c4bc53"),
    )
    val bytes = assets.sumOf { it.bytes }
    val directoryName = "compact-search-$REVISION"
}

internal class CompactSearchModel(app: Application, private val scope: CoroutineScope) : NativeLocalModel {
    private val dir = File(app.noBackupFilesDir, CompactSearchFiles.directoryName)
    private val staged = File(app.noBackupFilesDir, dir.name + ".part")
    private val installed = LocalModelState(LocalModelPhase.DOWNLOADED, CompactSearchFiles.bytes)
    private val invalid = LocalModelState(error = "The compact model failed verification. Download it again.")
    private val mutable = MutableStateFlow(LocalModelState())
    override val state = mutable.asStateFlow()
    private var transfer: Job? = null
    @Volatile private var connection: HttpURLConnection? = null
    private val engines = LocalEngineSession(scope,
        fileIdentity = {
            try {
                CompactSearchFiles.assets.map { asset -> Os.stat(File(dir, asset.name).path).let {
                    listOf(it.st_dev, it.st_ino, it.st_size, it.st_mtim, it.st_ctim)
                } }
            } catch (e: Exception) { mutable.value = invalid; throw e }
        },
        verify = { verifyFiles() },
        create = { CompactSearchWebView(app, dir) },
        initialize = {},
        afterUse = {
            if (mutable.value.phase in setOf(LocalModelPhase.LOADING, LocalModelPhase.REVIEWING)) mutable.value = installed
        },
    )

    init {
        if (dir.isDirectory) {
            mutable.value = LocalModelState(LocalModelPhase.VERIFYING)
            transfer = scope.launch(Dispatchers.IO) {
                try { verifyFiles(); mutable.value = installed }
                catch (cancel: CancellationException) { throw cancel }
                catch (_: Exception) { mutable.value = invalid }
            }
        }
    }

    private suspend fun verifyFiles() {
        val context = currentCoroutineContext()
        try {
            CompactSearchFiles.assets.forEach { asset ->
                File(dir, asset.name).inputStream().use { input ->
                    LocalModelContract.copyVerified(input, null, asset.bytes, asset.hash) { context.ensureActive() }
                }
            }
        } catch (cancel: CancellationException) { throw cancel }
        catch (e: Exception) { mutable.value = invalid; throw e }
    }

    override fun stop() { engines.invalidate() }

    override fun cancelDownload() {
        if (state.value.phase == LocalModelPhase.DOWNLOADING) {
            transfer?.cancel()
            connection?.disconnect()
        }
    }

    private suspend fun fetch(asset: CompactSearchFiles.Asset, previous: Long) {
        val context = currentCoroutineContext()
        val http = asset.url.openConnection() as HttpURLConnection
        connection = http
        try {
            http.connectTimeout = 20_000
            http.readTimeout = 30_000
            context.ensureActive()
            check(http.responseCode == 200 && http.url.protocol == "https")
            File(staged, asset.name).outputStream().use { output ->
                http.inputStream.use { input ->
                    LocalModelContract.copyVerified(input, output, asset.bytes, asset.hash) { count ->
                        context.ensureActive()
                        mutable.value = LocalModelState(LocalModelPhase.DOWNLOADING, previous + count)
                    }
                }
                output.fd.sync()
            }
        } finally {
            http.disconnect()
            connection = null
        }
    }

    override fun download() {
        if (state.value.phase != LocalModelPhase.ABSENT || transfer?.isActive == true) return
        mutable.value = LocalModelState(LocalModelPhase.DOWNLOADING)
        transfer = scope.launch(Dispatchers.IO) {
            try {
                engines.invalidate().join()
                if (staged.exists()) check(staged.deleteRecursively())
                check(staged.mkdirs() && staged.usableSpace > CompactSearchFiles.bytes + 16_000_000)
                var previous = 0L
                for (asset in CompactSearchFiles.assets) {
                    ensureActive()
                    fetch(asset, previous)
                    previous += asset.bytes
                }
                ensureActive()
                // A complete installation is never published under a partially verified path.
                if (dir.exists()) check(dir.deleteRecursively())
                check(staged.renameTo(dir))
                mutable.value = installed
            } catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) {
                mutable.value = LocalModelState(error = "Compact download did not finish. Check your connection and free space, then retry.")
            } finally { staged.deleteRecursively() }
        }.also { job ->
            job.invokeOnCompletion { error ->
                if (error is CancellationException && mutable.value.phase == LocalModelPhase.DOWNLOADING) mutable.value = LocalModelState()
            }
        }
    }

    override fun delete() {
        if (state.value.busy || transfer?.isActive == true) return
        mutable.value = LocalModelState(LocalModelPhase.DELETING)
        transfer = scope.launch(Dispatchers.IO) {
            engines.invalidate().join()
            mutable.value = if (!dir.exists() || dir.deleteRecursively()) LocalModelState()
                else LocalModelState(error = "Could not remove the compact model.")
        }
    }

    private suspend fun plan(engine: CompactSearchWebView, planning: LocalSearchPlanInput): List<String> {
        val observed = planning.observedTags.take(128)
        val reply = try {
            withTimeout(8_000) { engine.request("plan", JSONObject().put("query", planning.query).put("tags", JSONArray(observed))) }
        } catch (_: TimeoutCancellationException) { return emptyList() }
        catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { return emptyList() }

        fun hints(key: String, count: Int): List<String> {
            val array = reply.optJSONArray(key) ?: return emptyList()
            return (0 until minOf(count, array.length())).map { array.getString(it) }.filter { term ->
                term.isNotBlank() && term.length <= 60 && term.any(Char::isLetterOrDigit) && term.none(Char::isISOControl)
            }
        }
        return (hints("tags", 4).filter { it in observed } + hints("terms", 2)).distinct()
    }

    override suspend fun classify(
        batch: LocalCurationBatch, sandbox: Boolean, run: Long?, planning: LocalSearchPlanInput?,
        onPlan: suspend (List<String>) -> LocalCurationBatch, onDecision: suspend (LocalCurationDecision) -> Unit,
    ): List<LocalCurationDecision> {
        val revision = engines.revision
        check(state.value.available) { "Download the compact search model in Settings first." }
        return withContext(Dispatchers.IO) {
            engines.use(run, revision) { engine ->
                mutable.value = LocalModelState(LocalModelPhase.LOADING)
                engine.request("load")
                val active = if (planning == null) batch else onPlan(plan(engine, planning))
                require(!active.homeFeed && active.candidates.size <= 24)
                active.candidates.mapIndexed { index, candidate ->
                    ensureActive()
                    mutable.value = LocalModelState(LocalModelPhase.REVIEWING, reviewed = index, total = active.candidates.size)
                    val listing = candidate.listing
                    val projection = JSONObject().put("title", listing.title.take(500)).put("description", listing.description.take(2000))
                        .put("side", listing.side).put("price", listing.price).put("currency", listing.currency)
                        .put("location", listing.location).put("category", listing.category).put("tags", JSONArray(listing.tags.take(24)))
                    val result = engine.request("review", JSONObject().put("query", active.interests).put("listing", projection))
                    val score = result.getDouble("score")
                    require(score.isFinite() && score in 0.0..1.0)
                    val show = result.getBoolean("show")
                    require(show == (score >= 0.5))
                    val decision = LocalCurationDecision(candidate.eventId, show, if (show) "Matches your search" else "Does not match your search", score)
                    ensureActive()
                    onDecision(decision)
                    decision
                }
            }
        }
    }
}
