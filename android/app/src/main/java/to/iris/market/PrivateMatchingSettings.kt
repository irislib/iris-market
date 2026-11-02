package to.iris.market

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@Composable
internal fun PrivateMatchingSettings(state:MarketSnapshot, model:MarketModel, busy:Boolean) {
    val book = remember(state.privateMatching) { state.privateMatching?.let { JSONObject(it) } }
    var open by remember { mutableStateOf(false) }
    fun act(op:String, vararg fields:Pair<String,Any>) {
        val action = JSONObject().put("op",op)
        fields.forEach { (key,value) -> action.put(key,value) }
        model.command(JSONObject().put("type","private_match").put("action",action))
    }
    Row(verticalAlignment=Alignment.CenterVertically) {
        Text("Find a match privately",Modifier.weight(1f))
        Switch(book!=null,onCheckedChange={ act("enable","enabled" to it) },enabled=!busy)
    }
    if(book==null) return
    TextButton(onClick={open=true}) { Text("Open private matching") }
    if(!open) return
    var helper by remember { mutableStateOf("") }
    var summary by remember { mutableStateOf("") }
    var request by remember { mutableStateOf(true) }
    var selected by remember { mutableStateOf("") }
    var candidates by remember { mutableStateOf(emptyList<JSONObject>()) }
    var error by remember { mutableStateOf("") }
    LaunchedEffect(selected) {
        candidates=emptyList()
        if(selected.isNotEmpty()) try { candidates=model.privateMatchCandidates(selected) }
        catch(e:kotlinx.coroutines.CancellationException) { throw e }
        catch(e:Exception) { error=e.localizedMessage ?: "Could not load matches" }
    }
    AlertDialog(onDismissRequest={open=false},title={Text("Private matching")},confirmButton={
        TextButton(onClick={open=false}) {Text("Done")}
    },text={
        Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)) {
            Text("A helper you choose can look for matches for up to seven days.")
            Row {
                FilterChip(request,{request=true},{Text("Looking for")})
                FilterChip(!request,{request=false},{Text("Offering")})
            }
            OutlinedTextField(helper,{helper=it},label={Text("Helper’s public key (hex)")})
            OutlinedTextField(summary,{summary=it},label={Text("Summary your helper may share")})
            Button(enabled=!busy && summary.isNotBlank() && helper.isNotBlank(),onClick={
                val action=JSONObject().put("op","share").put("helper",helper.trim()).put("summary",summary).put("side",if(request) "request" else "offer")
                model.command(JSONObject().put("type","private_match").put("action",action)) { summary="" }
            }) {Text("Send to helper privately")}
            if(error.isNotBlank()) Text(error)
            for(group in listOf("sent","received","interests","pairs","public_leads")) {
                val rows=book.optJSONObject(group) ?: continue
                for(id in rows.keys().asSequence().sorted()) {
                    val row=rows.getJSONObject(id)
                    when(group) {
                        "sent" -> { Text(row.getString("summary")); TextButton({act("withdraw","entry" to id)}) { Text("Withdraw") } }
                        "received" -> {
                            Text(row.getString("summary")); TextButton({selected=id}) {Text("Find matches")}
                            if(selected==id) for(item in candidates) {
                                Text(item.getString("summary"))
                                val privateEntry=item.getString("kind")=="private"
                                TextButton({
                                    if(privateEntry) act("suggest","left" to id,"right" to item.getString("id"))
                                    else act("send_public","entry" to id,"listing" to item.getString("id"))
                                }) {Text(if(privateEntry) "Ask both privately" else "Send public listing privately")}
                            }
                        }
                        "interests" -> {
                            Text(row.getString("summary"))
                            if(!row.isNull("contact")) SelectionContainer { Text(row.getString("contact")) }
                            else if(row.isNull("vote")) {
                                TextButton({act("vote","proposal" to id,"accept" to true)}) {Text("Agree to an introduction")}
                                TextButton({act("vote","proposal" to id,"accept" to false)}) {Text("Decline")}
                            }
                        }
                        "pairs" -> {
                            val votes=row.getJSONArray("votes")
                            if(votes.optBoolean(0)&&votes.optBoolean(1)&&!row.getBoolean("introduced")) {
                                val entries=row.getJSONArray("entries")
                                Text(List(entries.length()){book.getJSONObject("received").getJSONObject(entries.getString(it)).getString("summary")}.joinToString(" · "))
                                TextButton({act("introduce","proposal" to id)}) {Text("Introduce privately")}
                            }
                        }
                        "public_leads" -> {Text(row.getString("title")); SelectionContainer {Text(row.getString("listing"))} }
                    }
                }
            }
        }
    })
}
