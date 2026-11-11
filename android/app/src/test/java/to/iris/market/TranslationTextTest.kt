package to.iris.market

import org.junit.Assert.*
import org.junit.Test

class TranslationTextTest {
    @Test fun excludesTargetAndAdditionalReadingLanguages() {
        assertFalse(translationNeeded("en-US", "en-GB", emptySet()))
        assertFalse(translationNeeded("sv-FI", "fi", setOf("sv", "en")))
        assertTrue(translationNeeded("zh-Hant", "zh-Hans", emptySet()))
        assertFalse(translationNeeded("zh-Hant", "en", setOf("zh")))
        assertTrue(translationNeeded("zh-Hant", "en", setOf("zh-Hans")))
        assertFalse(translationNeeded("und", "en", emptySet()))
        assertTrue(translationNeeded("sv-FI", "fi", emptySet()))
    }

    @Test fun preservesAttachmentsNumbersTokensAndWhitespaceExactly() {
        val text = TranslationText("  Saatavana X100 hintaan 20 EUR\n[Kuva](https://example.org/photo.jpg)\nMaksa cashuA123secret  ")
        assertEquals(listOf("Saatavana", "hintaan", "Maksa"), text.phrases)
        assertEquals("  Available X100 for 20 EUR\n[Kuva](https://example.org/photo.jpg)\nPay cashuA123secret  ",
            text.assemble(listOf("Available", "for", "Pay").iterator()))
    }

    @Test fun startsFromAdditionalDeviceLanguagesAndHonorsExplicitEmptyList() {
        val device = listOf("en-US", "fi-FI", "en-GB", "sv")
        assertEquals(setOf("fi", "sv"), readingLanguages(null, device))
        assertEquals(emptySet<String>(), readingLanguages(emptySet(), device))
        assertEquals(setOf("de"), readingLanguages(setOf("de"), device))
    }

    @Test fun numericAndLinkOnlyTextHasNoDetectionSample() {
        assertTrue(TranslationText("240 € https://example.com/page").phrases.isEmpty())
    }
}
