package to.iris.market

import android.os.Build
import android.view.translation.TranslationCapability
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import kotlinx.coroutines.runBlocking

class DeviceTranslationTest {
    @Test fun recognizesForeignListingTextOnDevice() {
        assumeTrue(Build.VERSION.SDK_INT >= 31)
        val device = DeviceTranslation(ApplicationProvider.getApplicationContext())
        runBlocking {
            assertEquals("en-Latn", device.identify("Can I pick up this bicycle tomorrow afternoon?"))
            assertNull(device.identify("OK"))
        }
    }

    @Test fun translatesWithAnInstalledOnDevicePair() {
        assumeTrue(Build.VERSION.SDK_INT >= 31)
        val device = DeviceTranslation(ApplicationProvider.getApplicationContext())
        runBlocking {
            device.refresh()
            val samples = mapOf("en" to "Can I pick up this bicycle tomorrow afternoon?",
                "de" to "Kann ich dieses Fahrrad morgen Nachmittag abholen?",
                "es" to "¿Puedo recoger esta bicicleta mañana por la tarde?",
                "fr" to "Puis-je récupérer ce vélo demain après-midi ?")
            val pair = device.pairs.firstOrNull { it.state == TranslationCapability.STATE_ON_DEVICE &&
                it.sourceSpec.locale.language in samples && it.targetSpec.locale.language != it.sourceSpec.locale.language }
            assumeTrue("No installed pair for the sample languages. Installed ${device.pairs.count { it.state == TranslationCapability.STATE_ON_DEVICE }} of ${device.pairs.size} pairs.", pair != null)
            val source = samples.getValue(requireNotNull(pair).sourceSpec.locale.language)
            val text = TranslationText("$source\n[Photo](https://example.org/picture.jpg)")
            val result = device.translate(pair, listOf(text))?.singleOrNull()
            assertNotNull("Installed pair returned no translation", result)
            assertNotEquals(text.original, result)
            assertTrue(result!!.endsWith("\n[Photo](https://example.org/picture.jpg)"))
        }
    }
}
