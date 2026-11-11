package to.iris.market

import android.icu.util.ULocale
import com.google.android.gms.tasks.Task
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.TranslateRemoteModel
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.TranslatorOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** ML Kit performs inference on the device. Only a reader's explicit download action requests models. */
internal class GoogleDeviceTranslation {
    private val languages = TranslateLanguage.getAllLanguages().associateBy { translationTag(ULocale.forLanguageTag(it)) }

    suspend fun pairs(): List<ReaderLanguagePair> {
        val models = try {
            RemoteModelManager.getInstance().getDownloadedModels(TranslateRemoteModel::class.java).resultAsync()
                .map { it.language }.toSet()
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { emptySet() }
        // ML Kit uses English as its pivot; only non-English languages have downloadable models.
        val installed = models + TranslateLanguage.ENGLISH
        return languages.flatMap { (source, sourceCode) ->
            languages.filterKeys { it != source }.map { (target, targetCode) ->
                ReaderLanguagePair(source, target, sourceCode in installed && targetCode in installed)
            }
        }
    }

    private fun client(pair: ReaderLanguagePair) = Translation.getClient(TranslatorOptions.Builder()
        .setSourceLanguage(languages.getValue(pair.source)).setTargetLanguage(languages.getValue(pair.target)).build())

    suspend fun download(pair: ReaderLanguagePair) {
        val translator = client(pair)
        try { translator.downloadModelIfNeeded(DownloadConditions.Builder().build()).resultAsync() }
        finally { translator.close() }
    }

    suspend fun translate(pair: ReaderLanguagePair, phrases: List<String>): List<String> {
        val translator = client(pair)
        return try { phrases.map { translator.translate(it).resultAsync() } }
        finally { translator.close() }
    }

    private suspend fun <T> Task<T>.resultAsync(): T = suspendCancellableCoroutine { continuation ->
        addOnCompleteListener { task ->
            if (task.isSuccessful) continuation.resume(task.result)
            else continuation.resumeWithException(task.exception ?: CancellationException("Model task cancelled"))
        }
    }
}
