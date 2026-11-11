package to.iris.market

import java.util.Currency
import java.util.Locale

private val currencyCodes = (Currency.getAvailableCurrencies().map { it.currencyCode } + listOf("BTC", "SAT", "SATS")).joinToString("|")

/** Keep links, payment references, model numbers and paragraph boundaries verbatim. */
private val protectedTokens = Regex(
    """!?\[[^\]\n]*\]\(https?://[^\s)]+\)|(?:\w+://|www\.|(?:nostr|bitcoin|lightning|cashu):)\S+|\b(?:cashu[AB]|ln(?:bc|tb|bcrt)|(?:npub|nprofile|nevent|naddr|note|bc)1)[\w-]+|[\w.+-]+@[\w.-]+\.\w+|\b(?:$currencyCodes)\b(?=[ \t]*\d)|\b\d+(?:[.,]\d+)*[ \t]*(?:$currencyCodes)\b|\b[\p{L}\d_-]*\d[\p{L}\d_.,:/-]*|[\r\n]+""",
    RegexOption.IGNORE_CASE
)

internal class TranslationText(val original: String) {
    private val pieces = mutableListOf<Pair<String, Boolean>>()

    init {
        fun prose(value: String) {
            val start = value.indexOfFirst { !it.isWhitespace() }
            if (start < 0 || value.none(Char::isLetter)) {
                pieces += value to false
                return
            }
            val end = value.indexOfLast { !it.isWhitespace() } + 1
            pieces += value.substring(0, start) to false
            pieces += value.substring(start, end) to true
            pieces += value.substring(end) to false
        }
        var offset = 0
        for (match in protectedTokens.findAll(original)) {
            prose(original.substring(offset, match.range.first))
            pieces += match.value to false
            offset = match.range.last + 1
        }
        prose(original.substring(offset))
    }

    val phrases = pieces.filter { it.second }.map { it.first }
    fun assemble(translations: Iterator<String>) =
        pieces.joinToString("") { (value, translate) -> if (translate) translations.next() else value }
}

internal fun languageScriptTag(locale: Locale) =
    if (locale.script.isEmpty()) locale.language else "${locale.language}-${locale.script}"

internal fun sameReadingLanguage(first: String, second: String): Boolean {
    val a = Locale.forLanguageTag(first)
    val b = Locale.forLanguageTag(second)
    return a.language == b.language && (a.script.isEmpty() || b.script.isEmpty() || a.script == b.script)
}

internal fun translationNeeded(source: String, target: String, languagesRead: Set<String>): Boolean {
    val language = Locale.forLanguageTag(source).language
    return language.isNotEmpty() && language != "und" && !sameReadingLanguage(source, target) &&
        languagesRead.none { sameReadingLanguage(source, it) }
}

internal fun readingLanguages(saved: Set<String>?, deviceTags: List<String>): Set<String> {
    if (saved != null) return saved.toSet()
    val deviceLanguages = deviceTags.map { languageScriptTag(Locale.forLanguageTag(it)) }.filter { it.isNotBlank() && it != "und" }.distinct()
    return deviceLanguages.drop(1).toSet()
}
