package to.iris.market

import android.content.Context
import android.icu.util.ULocale
import android.os.Build
import android.view.textclassifier.TextClassificationManager
import android.view.textclassifier.TextLanguage
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.Locale

/** Android's likely-subtag data resolves regional script conventions, e.g. zh-TW → zh-Hant. */
internal fun translationTag(locale: ULocale): String =
    languageScriptTag(ULocale.addLikelySubtags(locale).toLocale())

private fun preferredDeviceTag(locale: Locale): String {
    if (locale.script.isNotBlank()) return languageScriptTag(locale)
    val base = ULocale(locale.language)
    val resolved = translationTag(ULocale.forLocale(locale))
    return if (resolved == translationTag(base)) locale.language else resolved
}

/** Stores only reader preferences. Source text and results belong to their Compose view. */
internal class TranslationPreferences(context: Context) {
    private val prefs = context.getSharedPreferences("market-translation", Context.MODE_PRIVATE)
    var automatic by mutableStateOf(prefs.getBoolean("automatic", false))
        private set
    var target by mutableStateOf(prefs.getString("target", "").orEmpty())
        private set
    var languagesRead by mutableStateOf(readingLanguages(prefs.getStringSet("read", null), context.resources.configuration.locales.let { locales ->
        (0 until locales.size()).map { preferredDeviceTag(locales[it]) }
    }))
        private set

    fun changeAutomatic(value: Boolean) { automatic = value; prefs.edit().putBoolean("automatic", value).apply() }
    fun changeTarget(value: String) { target = value; prefs.edit().putString("target", value).apply() }
    fun changeRead(value: Set<String>) { languagesRead = value; prefs.edit().putStringSet("read", value).apply() }
}

internal val LocalReader = staticCompositionLocalOf<TranslationPreferences?> { null }
internal data class ReaderLanguagePair(val source: String, val target: String, val installed: Boolean)

internal class DeviceTranslation(private val context: Context) {
    private val classifier = context.getSystemService(TextClassificationManager::class.java)?.textClassifier
    private val system = if (Build.VERSION.SDK_INT >= 31) SystemTranslation(context) else null
    private val google = GoogleDeviceTranslation()
    private val refreshMutex = Mutex()
    private var byLanguage by mutableStateOf(emptyMap<Pair<String, String>, ReaderLanguagePair>())
    val pairs get() = byLanguage.values
    var targets by mutableStateOf(emptySet<String>())
        private set
    var scriptVariants by mutableStateOf(emptyList<String>())
        private set
    var usesGoogle by mutableStateOf(false)
        private set
    private val downloads = mutableStateMapOf<String, String>()

    suspend fun refresh() = refreshMutex.withLock {
        val systemPairs = withContext(Dispatchers.IO) {
            if (Build.VERSION.SDK_INT >= 31) try { system?.refresh().orEmpty() } catch (_: Exception) { emptyList() }
            else emptyList()
        }
        val available = if (systemPairs.isEmpty()) google.pairs() else systemPairs
        usesGoogle = systemPairs.isEmpty()
        byLanguage = available.associateBy { it.source to it.target }
        targets = available.map { it.target }.toSet()
        scriptVariants = available.flatMap { listOf(it.source, it.target) }.distinct()
            .groupBy { Locale.forLanguageTag(it).language }.values.filter { it.size > 1 }.flatten()
    }

    fun pair(source: String, target: String) = byLanguage[source to target]
    fun downloadStatus(pair: ReaderLanguagePair) = downloads[pair.source + "/" + pair.target]

    fun prepare(pair: ReaderLanguagePair, scope: CoroutineScope) {
        val key = pair.source + "/" + pair.target
        if (!usesGoogle) {
            val opened = Build.VERSION.SDK_INT >= 31 && runCatching { system?.openLanguageSettings() == true }.getOrDefault(false)
            if (!opened) downloads[key] = "Install this language pair in your device’s translation settings."
            return
        }
        if (downloads[key] == "Downloading languages…") return
        downloads[key] = "Downloading languages…"
        scope.launch {
            try {
                google.download(pair)
                refresh()
                downloads.remove(key)
            } catch (cancelled: CancellationException) {
                downloads.remove(key)
                throw cancelled
            } catch (_: Exception) {
                downloads[key] = "Language download failed. Try again."
            }
        }
    }

    suspend fun identify(sample: String): String? = withContext(Dispatchers.IO) {
        if (sample.count(Char::isLetter) < 4) return@withContext null
        val result = classifier?.detectLanguage(TextLanguage.Request.Builder(sample.take(2048)).build()) ?: return@withContext null
        if (result.localeHypothesisCount == 0) return@withContext null
        val best = result.getLocale(0)
        translationTag(best).takeIf { result.getConfidenceScore(best) >= 0.8f }
    }

    suspend fun translate(pair: ReaderLanguagePair, fields: List<TranslationText>): List<String>? {
        if (!pair.installed) return null
        val phrases = fields.flatMap { it.phrases }
        if (phrases.isEmpty()) return null
        val values = if (usesGoogle) google.translate(pair, phrases)
            else if (Build.VERSION.SDK_INT >= 31) system?.translate(pair, phrases) else null
        if (values == null || values.size != phrases.size || values.any(String::isBlank)) return null
        val result = values.iterator()
        return fields.map { it.assemble(result) }
    }
}

internal val LocalDeviceTranslation = staticCompositionLocalOf<DeviceTranslation?> { null }
private val LocalTranslationScope = staticCompositionLocalOf<CoroutineScope?> { null }

@Composable internal fun TranslationHost(content: @Composable () -> Unit) {
    val context = LocalContext.current.applicationContext
    val prefs = remember(context) { TranslationPreferences(context) }
    val engine = remember(context) { DeviceTranslation(context) }
    val scope = rememberCoroutineScope()
    var refresh by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { refresh++ }
    LaunchedEffect(engine, refresh) { engine.refresh() }
    CompositionLocalProvider(LocalReader provides prefs, LocalDeviceTranslation provides engine, LocalTranslationScope provides scope, content = content)
}

@Composable internal fun translationTarget(): Locale {
    val default = LocalConfiguration.current.locales[0]
    return LocalReader.current?.target?.takeIf(String::isNotBlank)?.let(Locale::forLanguageTag) ?: default
}

internal data class ReadingTranslation(
    val text: List<String>,
    val action: String? = null,
    val status: String? = null,
    val googleAttribution: Boolean = false,
    val activate: () -> Unit = {}
)

@Composable internal fun rememberTranslation(fields: List<String>, sample: String = fields.joinToString("\n")): ReadingTranslation {
    val prefs = LocalReader.current
    val engine = LocalDeviceTranslation.current
    val target = translationTarget()
    val targetTag = translationTag(ULocale.forLocale(target))
    if (prefs == null || engine == null || targetTag !in engine.targets) {
        return ReadingTranslation(fields)
    }
    return key(fields, sample, target, prefs.languagesRead, prefs.automatic) {
        rememberSupportedTranslation(fields, sample, engine, prefs, targetTag)
    }
}

@Composable private fun rememberSupportedTranslation(
    fields: List<String>, sample: String, engine: DeviceTranslation,
    prefs: TranslationPreferences, targetTag: String
): ReadingTranslation {
    val parts = remember { fields.map(::TranslationText) }
    var source by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(engine) {
        if (parts.any { it.phrases.isNotEmpty() }) {
            source = try { engine.identify(TranslationText(sample.take(4096)).phrases.joinToString(" ")) }
            catch (e: CancellationException) { throw e } catch (_: Exception) { null }
        }
    }
    val from = source ?: return ReadingTranslation(fields)
    if (!translationNeeded(from, targetTag, prefs.languagesRead)) return ReadingTranslation(fields)
    val pair = engine.pair(from, targetTag) ?: return ReadingTranslation(fields)
    val sourceName = Locale.forLanguageTag(from).displayLanguage
    val manualAction = if (engine.usesGoogle) "Translate with Google" else "Translate from $sourceName"
    var show by remember { mutableStateOf(prefs.automatic) }
    if (!pair.installed) {
        val scope = LocalTranslationScope.current ?: return ReadingTranslation(fields)
        val downloadStatus = engine.downloadStatus(pair)
        val action = if (downloadStatus == "Downloading languages…") null
            else if (engine.usesGoogle) "Download languages to translate" else manualAction
        return ReadingTranslation(fields, action, downloadStatus) {
            show = true
            engine.prepare(pair, scope)
        }
    }
    var result by remember { mutableStateOf<List<String>?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(show, pair) {
        if (show && result == null) {
            status = "Translating…"
            result = try { engine.translate(pair, parts) }
            catch (e: CancellationException) { throw e } catch (_: Exception) { null }
            status = if (result == null) "Translation unavailable." else null
            if (result == null) show = false
        }
    }
    return ReadingTranslation(
        if (show) result ?: fields else fields,
        if (show) "Show original" else manualAction, status,
        googleAttribution = show && result != null && engine.usesGoogle
    ) { status = null; show = !show }
}
