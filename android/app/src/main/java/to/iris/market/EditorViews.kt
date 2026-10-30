package to.iris.market

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import org.json.JSONArray
import org.json.JSONObject

@Composable fun MarketField(value:String, change:(String)->Unit, label:String, lines:Int=1,
    hint:String?=null, keyboard:KeyboardType=KeyboardType.Text) {
    OutlinedTextField(value=value,onValueChange=change,label={Text(label)},
        placeholder=if(hint!=null) {{Text(hint)}} else null,
        modifier=Modifier.fillMaxWidth(),singleLine=lines==1,minLines=lines,
        shape=RoundedCornerShape(14.dp), keyboardOptions=KeyboardOptions(keyboardType=keyboard),
        colors=OutlinedTextFieldDefaults.colors(unfocusedBorderColor=Line,focusedBorderColor=Forest,
            unfocusedContainerColor=White,focusedContainerColor=White))
}

@Composable fun PostListing(state:MarketSnapshot,model:MarketModel,busy:Boolean,transportType:NativeTransportType?=null,initialArea:String="",initialServiceAreas:String?=null,done:()->Unit) {
    var expiry by remember { mutableStateOf(NativeListingExpiry.NEVER) }
    var expiryOpen by remember { mutableStateOf(false) }
    var confirmPublish by remember { mutableStateOf(false) }
    var side by remember { mutableStateOf("offer") }
    var title by remember { mutableStateOf(transportType?.serviceTitle ?: "") };var description by remember { mutableStateOf("") }
    var price by remember { mutableStateOf("") };var currency by remember { mutableStateOf("EUR") }
    var location by remember { mutableStateOf(initialArea) };var category by remember { mutableStateOf(if(transportType == null) "Other" else "Transport") }
    var transport by remember { mutableStateOf(transportType) }
    var serviceAreas by remember {mutableStateOf(initialServiceAreas)}
    var chooseServiceAreas by remember {mutableStateOf(false)}
    var imageUrl by remember { mutableStateOf("") };var categoriesOpen by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(horizontal=24.dp).padding(bottom=30.dp),
        verticalArrangement=Arrangement.spacedBy(13.dp)) {
        Text("New listing",style=MaterialTheme.typography.headlineMedium)
        Row(horizontalArrangement=Arrangement.spacedBy(9.dp)) {
            listOf("offer" to "Selling", "request" to "Buying").forEach { (v,label) ->
                FilterChip(selected=side==v,onClick={side=v},label={Text(label)},shape=CircleShape)
            }
        }
        MarketField(title,{title=it},"Title",hint="Reading chair")
        MarketField(description,{description=it},"Description",lines=3,hint="Condition, details, and what someone should know")
        Row(horizontalArrangement=Arrangement.spacedBy(12.dp)) {
            Box(Modifier.weight(1f)) { MarketField(price,{price=it},if(side=="request") "Budget" else "Price",keyboard=KeyboardType.Decimal) }
            Box(Modifier.width(100.dp)) { MarketField(currency,{currency=it.uppercase().take(6)},"Currency") }
        }
        Box {
            OutlinedButton(onClick={expiryOpen=true}, modifier=Modifier.fillMaxWidth().height(52.dp).testTag("listingExpiry"), shape=RoundedCornerShape(14.dp)) {
                Text("Expires in"); Spacer(Modifier.weight(1f)); Text(expiry.label); Icon(Icons.Filled.ExpandMore,null)
            }
            DropdownMenu(expanded=expiryOpen,onDismissRequest={expiryOpen=false}) {
                NativeListingExpiry.entries.forEach { choice -> DropdownMenuItem(text={Text(choice.label)},onClick={expiry=choice;expiryOpen=false}) }
            }
        }
        MarketField(location,{location=it},if(transport == null) "Location" else "Pickup area",hint="City or neighbourhood")
        Box {
            OutlinedButton(onClick={categoriesOpen=true},shape=RoundedCornerShape(14.dp),modifier=Modifier.fillMaxWidth().height(52.dp)) {
                Text(category);Spacer(Modifier.weight(1f));Icon(Icons.Filled.ExpandMore,null)
            }
            DropdownMenu(expanded=categoriesOpen,onDismissRequest={categoriesOpen=false}) {
                listOf("Home","Electronics","Clothing","Outdoors","Transport","Services","Work","Other").forEach { value ->
                    DropdownMenuItem(text={Text(value)},onClick={category=value;categoriesOpen=false})
                }
            }
        }
        if(category == "Transport") {
            Text("Service type",fontWeight=FontWeight.Medium)
            Row(Modifier.horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                FilterChip(transport==null,{transport=null},label={Text("Other")})
                NativeTransportType.entries.forEach { choice -> FilterChip(transport==choice,{transport=choice},label={Text(choice.label)}) }
            }
        }
        if(category == "Transport" && transport != null) {
            OutlinedButton(onClick={chooseServiceAreas=true},enabled=!state.demo,modifier=Modifier.fillMaxWidth().testTag("transportServiceAreas")) {Icon(Icons.Filled.Map,null);Spacer(Modifier.width(8.dp));Text(if(serviceAreas==null) "Choose pickup and destination areas" else "Edit service areas")}
            Text("Search a place, drop a pin, and choose your range. Boundaries become public only when you publish.",color=Muted,style=MaterialTheme.typography.bodySmall)
        }
        MarketField(imageUrl,{imageUrl=it},"Photo link · optional",hint="https://…",keyboard=KeyboardType.Uri)
        if(state.demo) Surface(color=Sand,shape=RoundedCornerShape(14.dp)) {
            Text("This is Preview. Switch to your live market to publish a listing.",Modifier.padding(14.dp),style=MaterialTheme.typography.bodySmall)
        } else Text("This listing will be public. Keep personal contact details and exact addresses out of the description.",color=Muted,style=MaterialTheme.typography.bodySmall)
        if(!state.demo && !state.canSign) Text("Sign in with your profile’s secret key to publish listings.",color=Muted,style=MaterialTheme.typography.bodySmall)
        Button(enabled=!state.demo && state.canSign && !busy && title.isNotBlank() && description.isNotBlank() && (category!="Transport" || transport==null || serviceAreas!=null),onClick={confirmPublish=true},modifier=Modifier.fillMaxWidth().height(54.dp),shape=RoundedCornerShape(16.dp)) {
            Text(if(busy) "Publishing…" else "Publish listing")
        }
    }
    if(chooseServiceAreas) ServiceAreaEditor(serviceAreas,{serviceAreas=it},{chooseServiceAreas=false})
    if(confirmPublish) AlertDialog(onDismissRequest={confirmPublish=false},title={Text("Publish your listing?")},
        text={Text("$title\n$location\nYour listing and availability for private enquiries will be public. Conversations stay encrypted.")},
        dismissButton={TextButton(onClick={confirmPublish=false}){Text("Keep editing")}},
        confirmButton={TextButton(onClick={
            confirmPublish=false
            val draft=JSONObject().put("title",title.trim()).put("description",description.trim()).put("side",side)
                .put("price",price.trim()).put("currency",currency.trim()).put("location",location.trim())
                .put("category",category).put("tags",JSONArray(if(category == "Transport") transport?.tags ?: emptyList<String>() else emptyList<String>())).put("image_url",imageUrl.trim().ifBlank { null } ?: JSONObject.NULL)
            if(category=="Transport")serviceAreas?.let {draft.put("service_areas",JSONObject(it))}
            model.publishListing(draft,expiry,done)
        }){Text("Publish")}})
}

@Composable fun SettingsView(state:MarketSnapshot,model:MarketModel,busy:Boolean,done:()->Unit) {
    val localModel by model.localModelState.collectAsState()
    val aiTest by model.aiTest.collectAsState()
    val testFocus=LocalFocusManager.current
    var testQuery by remember { mutableStateOf("bicycle") }
    var testListing by remember { mutableStateOf("City bicycle in working condition.") }
    val initial=remember { JSONObject(state.settings) }
    val clipboard=LocalClipboardManager.current
    val imageProxy=remember { initial.optJSONObject("image_proxy") ?: JSONObject() }
    var proxyEnabled by remember { mutableStateOf(imageProxy.optBoolean("enabled",true)) }
    var proxyURL by remember { mutableStateOf(imageProxy.optString("url","https://imgproxy.iris.to")) }
    val ai=remember { initial.optJSONObject("ai") ?: JSONObject() }
    var enabled by remember { mutableStateOf(ai.optBoolean("enabled")) }
    var provider by remember { mutableStateOf(ai.optString("provider","compatible")) }
    var endpoint by remember { mutableStateOf(ai.optString("base_url","https://api.openai.com/v1")) }
    var modelName by remember { mutableStateOf(ai.optString("model")) }
    var currency by remember { mutableStateOf(initial.optString("currency", "EUR")) }
    var currencyMenu by remember { mutableStateOf(false) }
    var presetID by remember { mutableStateOf(NativePreferences.matching(provider, endpoint).id) }
    val preset = NativePreferences.providers.first { it.id == presetID }
    var modelMenu by remember { mutableStateOf(false) }
    var customModel by remember { mutableStateOf(preset.models.none { it.first == modelName }) }
    val uri = LocalUriHandler.current
    var key by remember { mutableStateOf("") };var replaceKey by remember { mutableStateOf(false) }
    var providerMenu by remember { mutableStateOf(false) };var advanced by remember { mutableStateOf(false) }
    var servers by remember { mutableStateOf((initial.optJSONArray("relays") ?: JSONArray()).let { a -> (0 until a.length()).joinToString("\n"){a.getString(it)} }) }
    val settings={ JSONObject(initial.toString()).put("ai",JSONObject().put("enabled",enabled).put("provider",provider)
        .put("base_url",if(provider=="litert") "" else endpoint.trim()).put("model",if(provider=="litert") LocalModelManifest.ID else modelName.trim()).put("interests", "").put("curate_feed",false))
        .put("currency", currency)
        .put("relays",JSONArray(servers.lines().map{it.trim()}.filter{it.isNotEmpty()}))
        .put("image_proxy",JSONObject(imageProxy.toString()).put("enabled",proxyEnabled).put("url",proxyURL.trim())) }
    val settingsJSON = settings().toString()
    val originalSettingsJSON = remember { settingsJSON }
    val owner = remember { state.publicKey }
    var aiIntentEpoch by remember { mutableStateOf(model.aiIntentEpoch) }
    val latestSave by rememberUpdatedState(newValue = { if(owner == model.state.value.publicKey && (settingsJSON != originalSettingsJSON || replaceKey)) model.saveSettings(settings(), provider, key, replaceKey, expectedAIIntent=aiIntentEpoch,onIntentCommitted={committed -> aiIntentEpoch=maxOf(aiIntentEpoch,committed)}) {} })
    DisposableEffect(Unit) { model.aiPreferencesEditing = true; onDispose { model.clearAITest(); latestSave(); model.aiPreferencesEditing = false } }
    LaunchedEffect(settingsJSON,key,testQuery,testListing) { model.clearAITest() }
    LaunchedEffect(settingsJSON, key, replaceKey) { delay(650); if(settingsJSON != originalSettingsJSON || replaceKey) { latestSave(); replaceKey = false } }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(horizontal=24.dp).padding(bottom=30.dp),verticalArrangement=Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment=Alignment.CenterVertically) {
            Icon(Icons.Filled.Settings,null,tint=Forest);Spacer(Modifier.width(10.dp));Text("Settings",style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.SemiBold)
        }
        Row(verticalAlignment=Alignment.CenterVertically) {
            Text("AI search",modifier=Modifier.weight(1f),fontWeight=FontWeight.Medium)
            Switch(checked=enabled,onCheckedChange={enabled=it},modifier=Modifier.testTag("enableAI"))
        }
        if(state.demo) Text("Preview stays offline. AI search is unavailable here.",color=Muted,style=MaterialTheme.typography.bodySmall)
        if(provider!="litert"&&!localModel.available&&NativeAIReadiness.canSelectLocalOnTap(provider,modelName,endpoint)) Text("On-device AI needs a downloaded, verified model.",color=Muted,style=MaterialTheme.typography.bodySmall)
        Surface(color=Mint,shape=RoundedCornerShape(16.dp)) {
            Text(if(provider=="litert") "Listing searches run on this device. No cloud fallback." else "Sends your search and public listing text to this provider.",
                Modifier.padding(16.dp),style=MaterialTheme.typography.bodySmall)
        }
        Box {
            OutlinedButton(onClick={providerMenu=true},modifier=Modifier.fillMaxWidth().height(52.dp),shape=RoundedCornerShape(14.dp)) {
                Text(preset.label)
                Spacer(Modifier.weight(1f));Icon(Icons.Filled.ExpandMore,null)
            }
            DropdownMenu(expanded=providerMenu,onDismissRequest={providerMenu=false}) {
                NativePreferences.providers.forEach { choice ->
                    DropdownMenuItem(text={Text(choice.label)},onClick={presetID=choice.id;provider=choice.provider;endpoint=choice.endpoint;modelName=choice.models.firstOrNull()?.first ?: "";customModel=choice.models.isEmpty();providerMenu=false;key="";replaceKey=false})
                }
            }
        }
        if(provider=="litert") {
            Text("Gemma 4 E2B",fontWeight=FontWeight.Medium)
            when(localModel.phase) {
                LocalModelPhase.ABSENT -> {
                    Button(enabled=!state.demo,onClick=model::downloadLocalModel) { Icon(Icons.Filled.Download,null);Spacer(Modifier.width(8.dp));Text("Download · ${LocalModelManifest.SIZE_LABEL}") }
                    Text("Keep the app open during download.",color=Muted,style=MaterialTheme.typography.bodySmall)
                }
                LocalModelPhase.DOWNLOADING -> {
                    LinearProgressIndicator(progress={ (localModel.bytes.toDouble()/LocalModelManifest.BYTES).toFloat() },modifier=Modifier.fillMaxWidth())
                    Row(verticalAlignment=Alignment.CenterVertically) {
                        Text("${localModel.bytes*100/LocalModelManifest.BYTES}% · ${localModel.bytes/1_000_000} / ${LocalModelManifest.BYTES/1_000_000} MB",Modifier.weight(1f),style=MaterialTheme.typography.bodySmall)
                        TextButton(onClick=model::cancelLocalModelDownload) { Text("Cancel") }
                    }
                }
                LocalModelPhase.DOWNLOADED -> Row(verticalAlignment=Alignment.CenterVertically) {
                    Text("Downloaded · ${LocalModelManifest.SIZE_LABEL}",Modifier.weight(1f),style=MaterialTheme.typography.bodySmall)
                    TextButton(onClick=model::deleteLocalModel) { Icon(Icons.Filled.Delete,null);Spacer(Modifier.width(6.dp));Text("Delete") }
                }
                else -> {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                    Row(verticalAlignment=Alignment.CenterVertically) {
                        Text(when(localModel.phase) {
                            LocalModelPhase.VERIFYING -> "Checking model"
                            LocalModelPhase.LOADING -> "Loading model"
                            LocalModelPhase.REVIEWING -> "Reviewing ${localModel.reviewed} of ${localModel.total}"
                            else -> "Removing model"
                        },Modifier.weight(1f),style=MaterialTheme.typography.bodySmall)
                        if(localModel.phase!=LocalModelPhase.DELETING && !aiTest.busy) TextButton(onClick=model::cancelLocalAI) { Text("Stop") }
                    }
                }
            }
            localModel.error?.let { Text(it,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall) }
        } else {
        if(presetID in listOf("custom", "ollama")) MarketField(endpoint,{endpoint=it;key="";replaceKey=false},"Service URL",keyboard=KeyboardType.Uri)
        if(preset.models.isNotEmpty()) Box {
            OutlinedButton(onClick={modelMenu=true}) { Text(if(customModel) "Custom model" else preset.models.firstOrNull { it.first==modelName }?.second ?: modelName) }
            DropdownMenu(expanded=modelMenu,onDismissRequest={modelMenu=false}) {
                preset.models.forEach { choice -> DropdownMenuItem(text={Text(choice.second)},onClick={modelName=choice.first;customModel=false;modelMenu=false}) }
                DropdownMenuItem(text={Text("Custom model")},onClick={customModel=true;modelMenu=false})
            }
        }
        if(customModel || preset.models.isEmpty()) MarketField(modelName,{modelName=it},"Model name")
        if(provider!="ollama") OutlinedTextField(value=key,onValueChange={key=it;replaceKey=true},label={Text("API key")},placeholder={Text("Saved keys stay on this device")},
            visualTransformation=PasswordVisualTransformation(),modifier=Modifier.fillMaxWidth(),singleLine=true,shape=RoundedCornerShape(14.dp))
        preset.keyURL?.let { url -> TextButton(onClick={uri.openUri(url)}) { Text(if(presetID=="systemone") "Service details" else "Get an API key") } }
        preset.infoURL?.let { url -> TextButton(onClick={uri.openUri(url)}) { Text(if(presetID=="gemini") "Provider terms · EEA conditions apply" else "Models and usage") } }
        }
        MarketField(testQuery,{testQuery=it},"Test search")
        MarketField(testListing,{testListing=it},"Example listing",lines=2)
        Text("Use sample text. This test does not change your feed.",color=Muted,style=MaterialTheme.typography.bodySmall)
        Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
            Button(enabled=!busy&&!aiTest.busy&&!state.demo&&NativeAITestInput(testQuery,testListing).validationError==null&&NativeAIReadiness.canEnable(provider,modelName,endpoint,localModel.available),onClick={
                testFocus.clearFocus()
                val runTest={model.testAI(NativeAITestInput(testQuery,testListing))}
                if(settingsJSON!=originalSettingsJSON||replaceKey) model.saveSettings(settings(),provider,key,replaceKey,expectedAIIntent=aiIntentEpoch,done=runTest) else runTest()
                replaceKey=false
            },modifier=Modifier.testTag("aiSandboxTest")) { Text("Test") }
            if(aiTest.busy) { CircularProgressIndicator(Modifier.size(20.dp));TextButton(onClick={model.clearAITest()},modifier=Modifier.testTag("aiSandboxStop")){Text("Stop")} }
        }
        aiTest.result?.let { result -> Text(result.summary(preset.label),style=MaterialTheme.typography.bodySmall,modifier=Modifier.testTag("aiSandboxResult"));result.error?.let {Text(it,color=Muted,style=MaterialTheme.typography.bodySmall)} }
        aiTest.error?.let { Text(it,color=Muted,style=MaterialTheme.typography.bodySmall,modifier=Modifier.testTag("aiSandboxError")) }
        Box {
            OutlinedButton(onClick={currencyMenu=true}) { Text("Display currency · $currency") }
            DropdownMenu(expanded=currencyMenu,onDismissRequest={currencyMenu=false}) { NativePreferences.currencies.forEach { choice -> DropdownMenuItem(text={Text(choice)},onClick={currency=choice;currencyMenu=false}) } }
        }
        HorizontalDivider(color=Line)
        Text("Photos",fontWeight=FontWeight.Medium)
        Row(verticalAlignment=Alignment.CenterVertically) {
            Text("Use image proxy",modifier=Modifier.weight(1f))
            Switch(checked=proxyEnabled,onCheckedChange={proxyEnabled=it})
        }
        if(proxyEnabled) MarketField(proxyURL,{proxyURL=it},"Image service URL",keyboard=KeyboardType.Uri)
        Text("Loads smaller photos through the selected service.",color=Muted,style=MaterialTheme.typography.bodySmall)
        TextButton(onClick={advanced=!advanced}) { Text(if(advanced) "Hide connection details" else "Connection details");Icon(Icons.Filled.ExpandMore,null) }
        if(advanced) {
            MarketField(servers,{servers=it},"Message servers · one address per line",lines=3)
            Text(state.status,color=Muted,style=MaterialTheme.typography.bodySmall)
            state.error?.let { Text(it,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall) }
            state.profile?.let { profile ->
                Text(profile.graphLabel,style=MaterialTheme.typography.bodySmall)
                Text(profile.coverage,color=Muted,style=MaterialTheme.typography.bodySmall)
                profile.error?.let { Text(it,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall) }
            }
            if(state.publicKey.isNotBlank()) TextButton(onClick={clipboard.setText(AnnotatedString(state.publicKey))}) {
                Icon(Icons.Filled.ContentCopy,null,Modifier.size(16.dp));Spacer(Modifier.width(7.dp));Text("Copy profile ID")
            }
            Text("Iris Market · 0.1.0",color=Muted,style=MaterialTheme.typography.labelSmall)
        }
        if(state.demo) Text("Preview makes no provider or network requests.",color=Muted,style=MaterialTheme.typography.bodySmall)
    }
}
