package to.iris.market

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalUriHandler

/** Public Markdown attachment links remain usable in the native listing reader. */
@Composable internal fun ListingDescription(value:String) {
    val uri=LocalUriHandler.current
    val links=Regex("\\[([^]\\n]{1,160})]\\((https://[^\\s)]+)\\)").findAll(value).toList()
    Column {
        var offset=0
        for(link in links) {
            if(link.range.first>offset)Text(value.substring(offset,link.range.first),style=MaterialTheme.typography.bodyLarge)
            TextButton(onClick={runCatching{uri.openUri(link.groupValues[2])}}) {Text(link.groupValues[1])}
            offset=link.range.last+1
        }
        if(offset<value.length)Text(value.substring(offset),style=MaterialTheme.typography.bodyLarge)
    }
}
