package to.iris.market

import android.content.Intent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

@Composable fun AccountSignInView(model: MarketModel,busy:Boolean,close:()->Unit) {
    var secret by remember {mutableStateOf("")}
    val invitation by model.deviceLinkUrl.collectAsState()
    val state by model.state.collectAsState()
    val initialOwner = remember {state.publicKey}
    LaunchedEffect(state.publicKey) {if(state.publicKey != initialOwner) close()}
    val context=LocalContext.current;val clipboard=LocalClipboardManager.current
    DisposableEffect(model) {onDispose {model.closeDeviceLink()}}
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp),verticalArrangement=Arrangement.spacedBy(20.dp)) {
        Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {Text("Sign in",style=MaterialTheme.typography.titleLarge,modifier=Modifier.weight(1f));TextButton(onClick=close){Text("Done")}}
        if(invitation!=null) {
            Icon(Icons.Filled.Link,null,Modifier.size(44.dp).align(Alignment.CenterHorizontally),tint=Forest)
            Text("Open this link on a device signed in to Iris Chat.",color=Muted)
            Button(onClick={context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {type="text/plain";putExtra(Intent.EXTRA_TEXT,invitation)},"Share link"))},modifier=Modifier.fillMaxWidth()) {Icon(Icons.Filled.Share,null);Spacer(Modifier.width(8.dp));Text("Share link")}
            TextButton(onClick={clipboard.setText(AnnotatedString(invitation!!))},modifier=Modifier.fillMaxWidth()){Text("Copy link")}
            LinearProgressIndicator(Modifier.fillMaxWidth());Text("Waiting for approval…",color=Muted)
        } else {
            Button(onClick={model.beginDeviceLink()},enabled=!busy,modifier=Modifier.fillMaxWidth()) {Icon(Icons.Filled.Link,null);Spacer(Modifier.width(8.dp));Text("Link this device")}
            Text("Or sign in with your secret key",color=Muted,style=MaterialTheme.typography.bodyMedium)
            OutlinedTextField(value=secret,onValueChange={secret=it},label={Text("Secret key")},visualTransformation=PasswordVisualTransformation(),singleLine=true,modifier=Modifier.fillMaxWidth(),shape=RoundedCornerShape(16.dp))
            OutlinedButton(onClick={model.signIn(secret.trim()){secret="";close()}},enabled=secret.isNotBlank()&&!busy,modifier=Modifier.fillMaxWidth()){if(busy) CircularProgressIndicator(Modifier.size(20.dp),strokeWidth=2.dp) else Text("Sign in")}
        }
    }
}
