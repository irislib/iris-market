package to.iris.market

import android.app.PendingIntent
import android.content.Context
import android.icu.util.ULocale
import android.os.Build
import android.os.CancellationSignal
import android.view.textclassifier.TextClassificationManager
import android.view.textclassifier.TextLanguage
import android.view.translation.*
import androidx.annotation.RequiresApi
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale
import kotlin.coroutines.resume

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
@RequiresApi(31)
internal class DeviceTranslation(private val context: Context) {
    private val manager = context.getSystemService(TranslationManager::class.java)
    private val classifier = context.getSystemService(TextClassificationManager::class.java)?.textClassifier
    // Android 12 can return the same Translator for two simultaneous requests for a pair.
    private val sessions = Mutex()
    var pairs by mutableStateOf(emptySet<TranslationCapability>())
        private set
    var settingsIntent: PendingIntent? by mutableStateOf(null)
        private set

    suspend fun refresh() {
        val (caps, settings) = withContext(Dispatchers.IO) {
            val format = TranslationSpec.DATA_FORMAT_TEXT
            runCatching { manager?.getOnDeviceTranslationCapabilities(format, format).orEmpty() }.getOrDefault(emptySet()) to
                runCatching { manager?.onDeviceTranslationSettingsActivityIntent }.getOrNull()
        }
        pairs = caps.filter { it.state == TranslationCapability.STATE_ON_DEVICE ||
            it.state == TranslationCapability.STATE_AVAILABLE_TO_DOWNLOAD || it.state == TranslationCapability.STATE_DOWNLOADING }.toSet()
        settingsIntent = settings
    }

    suspend fun identify(sample: String): String? = withContext(Dispatchers.IO) {
        if (sample.count(Char::isLetter) < 4) return@withContext null
        val result = classifier?.detectLanguage(TextLanguage.Request.Builder(sample.take(2048)).build()) ?: return@withContext null
        if (result.localeHypothesisCount == 0) return@withContext null
        val best = result.getLocale(0)
        translationTag(best).takeIf { result.getConfidenceScore(best) >= 0.8f }
    }

    suspend fun translate(pair: TranslationCapability, fields: List<TranslationText>): List<String>? =
        sessions.withLock {
            val phrases = fields.flatMap { it.phrases }
            if (phrases.isEmpty() || manager == null) return@withLock null
            withTimeoutOrNull(15_000L) {
                val spec = TranslationContext.Builder(pair.sourceSpec, pair.targetSpec).build()
                val translator = suspendCancellableCoroutine<Translator?> { continuation ->
                    manager.createOnDeviceTranslator(spec, context.mainExecutor) { translator ->
                        continuation.resume(translator) { _, abandoned, _ -> abandoned?.destroy() }
                    }
                } ?: return@withTimeoutOrNull null
                try {
                    val request = TranslationRequest.Builder().setTranslationRequestValues(
                        phrases.map(TranslationRequestValue::forText)
                    ).build()
                    val response = suspendCancellableCoroutine<TranslationResponse> { continuation ->
                        val signal = CancellationSignal()
                        continuation.invokeOnCancellation { signal.cancel() }
                        translator.translate(request, signal, context.mainExecutor) {
                            if (it.isFinalResponse && continuation.isActive) continuation.resume(it)
                        }
                    }
                    if (response.translationStatus != TranslationResponse.TRANSLATION_STATUS_SUCCESS) return@withTimeoutOrNull null
                    val values = phrases.indices.map { index ->
                        val value = response.translationResponseValues[index]
                        if (value?.statusCode != TranslationResponseValue.STATUS_SUCCESS) return@withTimeoutOrNull null
                        value.text?.toString()?.takeIf(String::isNotBlank) ?: return@withTimeoutOrNull null
                    }.iterator()
                    fields.map { it.assemble(values) }
                } finally { translator.destroy() }
            }
        }
}

internal val LocalDeviceTranslation = staticCompositionLocalOf<DeviceTranslation?> { null }

@Composable internal fun TranslationHost(content: @Composable () -> Unit) {
    val context = LocalContext.current.applicationContext
    val prefs = remember(context) { TranslationPreferences(context) }
    val engine = remember(context) { if (Build.VERSION.SDK_INT >= 31) DeviceTranslation(context) else null }
    if (Build.VERSION.SDK_INT >= 31 && engine != null) {
        var refresh by remember { mutableIntStateOf(0) }
        LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { refresh++ }
        LaunchedEffect(engine, refresh) { engine.refresh() }
    }
    CompositionLocalProvider(LocalReader provides prefs, LocalDeviceTranslation provides engine, content = content)
}

@Composable internal fun translationTarget(): Locale {
    val default = LocalConfiguration.current.locales[0]
    return LocalReader.current?.target?.takeIf(String::isNotBlank)?.let(Locale::forLanguageTag) ?: default
}

internal data class ReadingTranslation(
    val text: List<String>,
    val action: String? = null,
    val status: String? = null,
    val activate: () -> Unit = {}
)

@Composable internal fun rememberTranslation(fields: List<String>, sample: String = fields.joinToString("\n")): ReadingTranslation {
    val prefs = LocalReader.current
    val engine = LocalDeviceTranslation.current
    val target = translationTarget()
    val targetTag = translationTag(ULocale.forLocale(target))
    if (Build.VERSION.SDK_INT < 31 || prefs == null || engine == null || engine.pairs.none { translationTag(it.targetSpec.locale) == targetTag }) {
        return ReadingTranslation(fields)
    }
    return key(fields, sample, target, prefs.languagesRead, prefs.automatic) {
        rememberSupportedTranslation(fields, sample, engine, prefs, target, targetTag)
    }
}

@RequiresApi(31)
@Composable private fun rememberSupportedTranslation(
    fields: List<String>, sample: String, engine: DeviceTranslation,
    prefs: TranslationPreferences, target: Locale, targetTag: String
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
    val pair = engine.pairs.filter { translationTag(it.sourceSpec.locale) == from && translationTag(it.targetSpec.locale) == targetTag }
        .maxByOrNull { (if (it.state == TranslationCapability.STATE_ON_DEVICE) 2 else 0) + (if (it.targetSpec.locale.toLanguageTag() == target.toLanguageTag()) 1 else 0) }
        ?: return ReadingTranslation(fields)
    val sourceName = Locale.forLanguageTag(from).displayLanguage
    if (pair.state != TranslationCapability.STATE_ON_DEVICE) {
        val intent = engine.settingsIntent
        var status by remember { mutableStateOf<String?>(null) }
        return ReadingTranslation(fields, "Translate from $sourceName", status) {
            status = if (intent == null) "Install this language pair in your device’s translation settings."
                else try { intent.send(); null } catch (_: PendingIntent.CanceledException) { "Language settings unavailable." }
        }
    }

    var show by remember { mutableStateOf(prefs.automatic) }
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
        if (show) "Show original" else "Translate from $sourceName", status
    ) { status = null; show = !show }
}
