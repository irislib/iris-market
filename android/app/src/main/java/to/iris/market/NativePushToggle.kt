package to.iris.market

import android.Manifest
import android.os.Build
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

@Composable fun NativePushToggle(model:MarketModel,state:MarketSnapshot) {
    val enabled by model.pushEnabled.collectAsState()
    val context=LocalContext.current
    var denied by remember {mutableStateOf(false)}
    var requestedScope by remember {mutableStateOf<String?>(null)}
    var requestedOwner by remember {mutableStateOf<String?>(null)}
    val request=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {allowed->
        val owner=requestedOwner;val scope=requestedScope;requestedOwner=null;requestedScope=null
        if(owner==model.state.value.publicKey&&scope==model.pushConsentScope()){denied=!allowed;if(allowed)model.setPushEnabled(true,owner,scope)}
    }
    Row(verticalAlignment=Alignment.CenterVertically) {
        Text("Private notifications",Modifier.weight(1f))
        Spacer(Modifier.width(12.dp))
        Switch(checked=enabled,enabled=!state.demo&&!state.profileNameRequired&&state.publicKey.isNotBlank(),onCheckedChange={value->
            if(!value)model.setPushEnabled(false,state.publicKey)
            else if(Build.VERSION.SDK_INT>=33){requestedOwner=state.publicKey;requestedScope=model.pushConsentScope();request.launch(Manifest.permission.POST_NOTIFICATIONS)}
            else model.setPushEnabled(true,state.publicKey)
        })
    }
    if(denied)TextButton(onClick={context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:${context.packageName}")))}) {Text("Allow notifications in system settings")}
}
