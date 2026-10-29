package to.iris.market

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.foundation.layout.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ProfileSummaryTest {
    @get:Rule val compose=createComposeRule()
    @Test fun namedSummaryUsesExistingPeopleAndLinksWithoutNetwork() {
        var opened="";var followers=false
        val people=listOf("Maya","Lin","Noor").mapIndexed { i,name -> PublicPerson("synthetic-$i",name,null,PublicConnection("following",1,0,"Following")) }
        compose.setContent { MaterialTheme { Surface { Column(Modifier.fillMaxWidth().systemBarsPadding().padding(23.dp),verticalArrangement=Arrangement.spacedBy(16.dp)) { Text("Profile",style=MaterialTheme.typography.titleLarge); KnownFollowersLine(people,8,{opened=it},{followers=true}) } } } }
        compose.onNodeWithText("Followed by").assertIsDisplayed()
        compose.onNodeWithText("Maya").performClick();compose.runOnIdle { assertEquals("synthetic-0",opened) }
        compose.onNodeWithText("and 5 others").performClick();compose.runOnIdle { assertEquals(true,followers) }
        compose.onNodeWithText("Known").assertDoesNotExist()
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val folder=java.io.File(instrumentation.targetContext.getExternalFilesDir(null),"native-evidence").apply {mkdirs()}
        val bitmap=checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        try {java.io.File(folder,"profile-known-summary.png").outputStream().use {check(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it))}} finally {bitmap.recycle()}
    }
}
