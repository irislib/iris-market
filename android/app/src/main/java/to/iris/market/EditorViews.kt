package to.iris.market

import androidx.compose.foundation.layout.*
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
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

@Composable fun PostListing(state:MarketSnapshot,model:MarketModel,busy:Boolean,done:()->Unit) {
    var confirmPublish by remember { mutableStateOf(false) }
    var side by remember { mutableStateOf("offer") }
    var title by remember { mutableStateOf("") };var description by remember { mutableStateOf("") }
    var price by remember { mutableStateOf("") };var currency by remember { mutableStateOf("EUR") }
    var location by remember { mutableStateOf("") };var category by remember { mutableStateOf("Other") }
    var imageUrl by remember { mutableStateOf("") };var categoriesOpen by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(horizontal=24.dp).padding(bottom=30.dp),
        verticalArrangement=Arrangement.spacedBy(13.dp)) {
        Text("New listing",style=MaterialTheme.typography.headlineMedium)
        Row(horizontalArrangement=Arrangement.spacedBy(9.dp)) {
            listOf("offer" to "Offer", "request" to "Request").forEach { (v,label) ->
                FilterChip(selected=side==v,onClick={side=v},label={Text(label)},shape=CircleShape)
            }
        }
        MarketField(title,{title=it},"Title",hint="Reading chair")
        MarketField(description,{description=it},"Description",lines=3,hint="Condition, details, and what someone should know")
        Row(horizontalArrangement=Arrangement.spacedBy(12.dp)) {
            Box(Modifier.weight(1f)) { MarketField(price,{price=it},if(side=="request") "Budget" else "Price",keyboard=KeyboardType.Decimal) }
            Box(Modifier.width(100.dp)) { MarketField(currency,{currency=it.uppercase().take(6)},"Currency") }
        }
        MarketField(location,{location=it},"Location",hint="City or neighbourhood")
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
        MarketField(imageUrl,{imageUrl=it},"Photo link · optional",hint="https://…",keyboard=KeyboardType.Uri)
        if(state.demo) Surface(color=Sand,shape=RoundedCornerShape(14.dp)) {
            Text("This is Preview. Switch to your live market to publish a listing.",Modifier.padding(14.dp),style=MaterialTheme.typography.bodySmall)
        } else Text("This listing will be public. Keep personal contact details and exact addresses out of the description.",color=Muted,style=MaterialTheme.typography.bodySmall)
        Button(enabled=!state.demo && !busy && title.isNotBlank() && description.isNotBlank(),onClick={confirmPublish=true},modifier=Modifier.fillMaxWidth().height(54.dp),shape=RoundedCornerShape(16.dp)) {
            Text(if(busy) "Publishing…" else "Publish listing")
        }
    }
    if(confirmPublish) AlertDialog(onDismissRequest={confirmPublish=false},title={Text("Publish your listing?")},
        text={Text("Your listing and availability for private enquiries will be public. Conversations stay encrypted.")},
        dismissButton={TextButton(onClick={confirmPublish=false}){Text("Keep editing")}},
        confirmButton={TextButton(onClick={
            confirmPublish=false
            val draft=JSONObject().put("title",title.trim()).put("description",description.trim()).put("side",side)
                .put("price",price.trim()).put("currency",currency.trim()).put("location",location.trim())
                .put("category",category).put("image_url",imageUrl.trim().ifBlank { null } ?: JSONObject.NULL)
            model.command(JSONObject().put("type","publish").put("draft",draft),done)
        }){Text("Publish")}})
}

@Composable fun SettingsView(state:MarketSnapshot,model:MarketModel,busy:Boolean,done:()->Unit) {
    val initial=remember { JSONObject(state.settings) }
    val ai=remember { initial.optJSONObject("ai") ?: JSONObject() }
    var enabled by remember { mutableStateOf(ai.optBoolean("enabled")) }
    var provider by remember { mutableStateOf(ai.optString("provider","compatible")) }
    var endpoint by remember { mutableStateOf(ai.optString("base_url","https://api.openai.com/v1")) }
    var modelName by remember { mutableStateOf(ai.optString("model")) }
    var interests by remember { mutableStateOf(ai.optString("interests")) }
    var curate by remember { mutableStateOf(ai.optBoolean("curate_feed")) }
    var key by remember { mutableStateOf("") };var replaceKey by remember { mutableStateOf(false) }
    var providerMenu by remember { mutableStateOf(false) };var advanced by remember { mutableStateOf(false) }
    var servers by remember { mutableStateOf((initial.optJSONArray("relays") ?: JSONArray()).let { a -> (0 until a.length()).joinToString("\n"){a.getString(it)} }) }
    val settings={ JSONObject(initial.toString()).put("ai",JSONObject().put("enabled",enabled).put("provider",provider)
        .put("base_url",endpoint.trim()).put("model",modelName.trim()).put("interests",interests.trim()).put("curate_feed",curate))
        .put("relays",JSONArray(servers.lines().map{it.trim()}.filter{it.isNotEmpty()})) }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(horizontal=24.dp).padding(bottom=30.dp),verticalArrangement=Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment=Alignment.CenterVertically) {
            Icon(Icons.Filled.AutoAwesome,null,tint=Forest);Spacer(Modifier.width(10.dp));Text("AI settings",style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.SemiBold)
        }
        Row(verticalAlignment=Alignment.CenterVertically) {
            Text("Enable AI assistance",modifier=Modifier.weight(1f),fontWeight=FontWeight.Medium)
            Switch(checked=enabled,onCheckedChange={enabled=it})
        }
        Surface(color=Mint,shape=RoundedCornerShape(16.dp)) {
            Text("When you ask for curation, selected public listing text and your interests are sent to this provider. Private conversations are never included.",
                Modifier.padding(16.dp),style=MaterialTheme.typography.bodySmall)
        }
        Box {
            OutlinedButton(onClick={providerMenu=true},modifier=Modifier.fillMaxWidth().height(52.dp),shape=RoundedCornerShape(14.dp)) {
                Text(when(provider){"ollama"->"Ollama";"anthropic"->"Anthropic";else->"OpenAI-compatible"})
                Spacer(Modifier.weight(1f));Icon(Icons.Filled.ExpandMore,null)
            }
            DropdownMenu(expanded=providerMenu,onDismissRequest={providerMenu=false}) {
                listOf("compatible" to "OpenAI-compatible","ollama" to "Ollama","anthropic" to "Anthropic").forEach { (p,label) ->
                    DropdownMenuItem(text={Text(label)},onClick={provider=p;providerMenu=false;key="";replaceKey=false
                        endpoint=when(p){"ollama"->"http://10.0.2.2:11434";"anthropic"->"https://api.anthropic.com/v1";else->"https://api.openai.com/v1"}})
                }
            }
        }
        MarketField(endpoint,{endpoint=it},"Provider address",keyboard=KeyboardType.Uri)
        MarketField(modelName,{modelName=it},"Model name",hint="Your provider's exact model name")
        Row(verticalAlignment=Alignment.CenterVertically) {
            Text("Replace saved API key",modifier=Modifier.weight(1f),style=MaterialTheme.typography.bodyMedium)
            Switch(checked=replaceKey,onCheckedChange={replaceKey=it})
        }
        if(replaceKey) OutlinedTextField(value=key,onValueChange={key=it},label={Text("API key · optional for local models")},
            visualTransformation=PasswordVisualTransformation(),modifier=Modifier.fillMaxWidth(),singleLine=true,shape=RoundedCornerShape(14.dp),
            supportingText={Text("Encrypted on this device. Saving an empty value removes the old key.")})
        MarketField(interests,{interests=it},"Interests",lines=3,hint="Furniture, electronics, local work")
        Row(verticalAlignment=Alignment.CenterVertically) {
            Text("Curate listings",modifier=Modifier.weight(1f),fontWeight=FontWeight.Medium)
            Switch(checked=curate,onCheckedChange={curate=it},enabled=enabled)
        }
        TextButton(onClick={advanced=!advanced}) { Text(if(advanced) "Hide network settings" else "Network settings");Icon(Icons.Filled.ExpandMore,null) }
        if(advanced) MarketField(servers,{servers=it},"Message servers · one address per line",lines=3)
        Button(enabled=!busy,onClick={model.saveSettings(settings(),provider,key,replaceKey,done)},
            modifier=Modifier.fillMaxWidth().height(54.dp),shape=RoundedCornerShape(16.dp)) { Text("Save settings") }
        if(state.demo) Text("Preview makes no provider or network requests.",color=Muted,style=MaterialTheme.typography.bodySmall)
    }
}
