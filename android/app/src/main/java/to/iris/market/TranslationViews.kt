package to.iris.market

import android.icu.util.ULocale
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.res.painterResource
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import java.util.Locale

@Composable internal fun TranslationControl(translation: ReadingTranslation) {
    if (translation.googleAttribution) {
        val badge = if (LocalContentColor.current.luminance() > 0.5f) R.drawable.powered_by_google_translate_dark
            else R.drawable.powered_by_google_translate
        Image(painterResource(badge), "Translated by Google", modifier = Modifier.size(width = 122.dp, height = 16.dp))
    }
    translation.action?.let { action ->
        TextButton(onClick = translation.activate, contentPadding = PaddingValues(horizontal = 4.dp)) {
            Text(action, style = MaterialTheme.typography.labelMedium)
        }
    }
    translation.status?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Muted) }
}

@Composable internal fun TranslatedText(source: String, render: @Composable (String) -> Unit) {
    val reading = rememberTranslation(listOf(source))
    render(reading.text.first())
    TranslationControl(reading)
}

@Composable internal fun TranslationSettings() {
    val preferences = LocalReader.current ?: return
    val engine = LocalDeviceTranslation.current
    val target = translationTarget()
    val targetTag = translationTag(ULocale.forLocale(target))
    val supportedTargets = engine?.targets.orEmpty()
    val supported = targetTag in supportedTargets
    val targetName = Locale.forLanguageTag(languageScriptTag(target)).displayName
    val deviceLanguages = engine?.scriptVariants.orEmpty()
    val languages = remember(deviceLanguages, target, preferences.languagesRead) {
        (Locale.getISOLanguages().toList() + deviceLanguages + preferences.languagesRead + languageScriptTag(target))
            .distinct().map(Locale::forLanguageTag).filter { it.language.isNotBlank() && it.displayName.isNotBlank() }
            .distinctBy(::languageScriptTag).sortedBy { it.displayName }
    }
    var picker by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxWidth()) {
        Text("Translation", style = MaterialTheme.typography.titleMedium)
        Row(Modifier.fillMaxWidth().toggleable(value = preferences.automatic, enabled = supported, role = Role.Switch,
            onValueChange = preferences::changeAutomatic), verticalAlignment = Alignment.CenterVertically) {
            Text("Always translate into $targetName", Modifier.weight(1f))
            Switch(checked = preferences.automatic, enabled = supported, onCheckedChange = null)
        }
        if (!supported) Text(if (supportedTargets.isEmpty()) "On-device translation is unavailable on this device."
            else "On-device translation into $targetName is unavailable.", color = Muted, style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = { picker = "target" }) { Text("Translate into · $targetName") }
        val read = preferences.languagesRead.map { Locale.forLanguageTag(it).displayName }.sorted()
        TextButton(onClick = { picker = "read" }) { Text("Languages I read · ${read.joinToString().ifEmpty { "None selected" }}") }
    }
    if (picker != null) {
        val multiple = picker == "read"
        var query by remember(picker) { mutableStateOf("") }
        AlertDialog(onDismissRequest = { picker = null }, title = { Text(if (multiple) "Languages I read" else "Translate into") },
            text = {
                Column {
                    OutlinedTextField(query, { query = it }, singleLine = true, label = { Text("Search languages") })
                    LazyColumn(Modifier.heightIn(max = 360.dp)) {
                        if (!multiple && query.isBlank()) item {
                            Row(Modifier.fillMaxWidth().clickable { preferences.changeTarget(""); picker = null }.padding(vertical = 8.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                RadioButton(selected = preferences.target.isBlank(), onClick = null)
                                Text("Device language")
                            }
                        }
                        val choices = if (multiple || supportedTargets.isEmpty()) languages
                            else languages.filter { translationTag(ULocale.forLocale(it)) in supportedTargets }
                        items(choices.filter { it.displayName.contains(query, true) || it.getDisplayLanguage(it).contains(query, true) || it.language.equals(query, true) },
                            key = ::languageScriptTag) { locale ->
                            val tag = languageScriptTag(locale)
                            val selected = if (multiple) tag in preferences.languagesRead else preferences.target == tag
                            val select = {
                                if (multiple) {
                                    val old = preferences.languagesRead
                                    preferences.changeRead(if (selected) old - tag else old + tag)
                                } else { preferences.changeTarget(tag); picker = null }
                            }
                            Row(Modifier.fillMaxWidth().clickable(onClick = select).padding(vertical = 8.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (multiple) Checkbox(checked = selected, onCheckedChange = null)
                                else RadioButton(selected = selected, onClick = null)
                                Text(locale.displayName)
                            }
                        }
                    }
                }
            }, confirmButton = { TextButton(onClick = { picker = null }) { Text("Done") } })
    }
}
