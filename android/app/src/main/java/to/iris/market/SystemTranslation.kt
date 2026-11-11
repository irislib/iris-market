package to.iris.market

import android.content.Context
import android.os.CancellationSignal
import android.view.translation.*
import androidx.annotation.RequiresApi
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

@RequiresApi(31)
internal class SystemTranslation(private val context: Context) {
    private val manager = context.getSystemService(TranslationManager::class.java)
    // Android 12 can return the same Translator for simultaneous requests for a pair.
    private val sessions = Mutex()
    private var capabilities = emptyMap<Pair<String, String>, TranslationCapability>()

    fun refresh(): List<ReaderLanguagePair> {
        val format = TranslationSpec.DATA_FORMAT_TEXT
        val available = manager?.getOnDeviceTranslationCapabilities(format, format).orEmpty()
            .filter { it.state == TranslationCapability.STATE_ON_DEVICE || it.state == TranslationCapability.STATE_DOWNLOADING ||
                it.state == TranslationCapability.STATE_AVAILABLE_TO_DOWNLOAD }
            .sortedBy { it.state == TranslationCapability.STATE_ON_DEVICE }
        capabilities = available.associateBy { translationTag(it.sourceSpec.locale) to translationTag(it.targetSpec.locale) }
        return capabilities.map { (key, cap) -> ReaderLanguagePair(key.first, key.second, cap.state == TranslationCapability.STATE_ON_DEVICE) }
    }

    fun openLanguageSettings(): Boolean {
        val intent = manager?.onDeviceTranslationSettingsActivityIntent ?: return false
        intent.send()
        return true
    }

    suspend fun translate(pair: ReaderLanguagePair, phrases: List<String>): List<String>? {
        val cap = capabilities[pair.source to pair.target] ?: return null
        return translate(cap, phrases)
    }

    private suspend fun translate(pair: TranslationCapability, phrases: List<String>): List<String>? =
        sessions.withLock {
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
                    phrases.indices.map { index ->
                        val value = response.translationResponseValues[index]
                        if (value?.statusCode != TranslationResponseValue.STATUS_SUCCESS) return@withTimeoutOrNull null
                        value.text?.toString()?.takeIf(String::isNotBlank) ?: return@withTimeoutOrNull null
                    }
                } finally { translator.destroy() }
            }
        }
}
