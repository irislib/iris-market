package to.iris.market

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable internal fun ToolSwitch(title:String, detail:String, enabled:Boolean, change:(Boolean)->Unit) {
    Row(verticalAlignment=Alignment.CenterVertically, horizontalArrangement=Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            Text(title,style=MaterialTheme.typography.titleSmall)
            Text(detail,style=MaterialTheme.typography.bodySmall,color=Muted)
        }
        Switch(enabled,change)
    }
}
