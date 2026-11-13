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
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject

private fun matchAction(op: String, vararg fields: Pair<String, Any>): JSONObject {
    val action = JSONObject().put("op", op)
    fields.forEach { (key, value) -> action.put(key, value) }
    return JSONObject().put("type", "private_match").put("action", action)
}

@Composable
internal fun PrivateMatchingSettings(state: MarketSnapshot, model: MarketModel, busy: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Find a match privately", Modifier.weight(1f))
        Switch(state.privateMatching != null, onCheckedChange = {
            model.command(matchAction("enable", "enabled" to it))
        }, enabled = !busy)
    }
    PrivateMatchesLink(state, model, busy)
}

@Composable
internal fun PrivateMatchesLink(state: MarketSnapshot, model: MarketModel, busy: Boolean) {
    val book = remember(state.privateMatching) { state.privateMatching?.let { JSONObject(it) } } ?: return
    var open by remember(state.publicKey) { mutableStateOf(false) }
    TextButton(onClick = { open = true }) { Text("Private matches") }
    if (open) key(state.publicKey) { PrivateMatchesDialog(book, state, model, busy) { open = false } }
}

@Composable
private fun PrivateMatchesDialog(book: JSONObject, state: MarketSnapshot, model: MarketModel, busy: Boolean, close: () -> Unit) {
    var helping by remember { mutableStateOf(book.getJSONObject("interests").length() == 0 && book.getJSONObject("received").length() > 0) }
    var composing by remember { mutableStateOf(false) }
    var helper by remember { mutableStateOf("") }
    var summary by remember { mutableStateOf("") }
    var request by remember { mutableStateOf(true) }
    var selected by remember { mutableStateOf("") }
    var candidates by remember { mutableStateOf(emptyList<JSONObject>()) }
    var searching by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    fun act(op: String, vararg fields: Pair<String, Any>) { model.command(matchAction(op, *fields)) }

    AlertDialog(onDismissRequest = close, title = { Text("Private matches") }, confirmButton = {
        TextButton(onClick = close) { Text("Done") }
    }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(!helping, { helping = false }, { Text("My matches") })
                FilterChip(helping, { helping = true }, { Text("Helping") })
            }
            if (!helping) {
                TextButton({ composing = !composing }) { Text("Ask a helper") }
                if (composing) {
                    Text("Your helper may show this summary privately to someone with a possible match. Leave names and contact details out. It expires in seven days.")
                    Row {
                        FilterChip(request, { request = true }, { Text("Looking for") })
                        FilterChip(!request, { request = false }, { Text("Offering") })
                    }
                    if (state.conversations.isNotEmpty()) {
                        var choosing by remember { mutableStateOf(false) }
                        Box {
                            TextButton({ choosing = true }) { Text("Choose from your conversations") }
                            DropdownMenu(choosing, { choosing = false }) {
                                state.conversations.forEach { peer ->
                                    DropdownMenuItem(text = { Text("${peer.name} · ${peer.id.takeLast(6)}") }, onClick = {
                                        helper = peer.id; choosing = false
                                    })
                                }
                            }
                        }
                    }
                    OutlinedTextField(helper, { helper = it }, label = { Text("Helper’s npub or public key") })
                    OutlinedTextField(summary, { summary = it }, label = { Text("Shareable summary") })
                    Button(enabled = !busy && summary.isNotBlank() && helper.isNotBlank(), onClick = {
                        model.command(matchAction("share", "helper" to helper.trim(), "summary" to summary,
                            "side" to if (request) "request" else "offer")) { summary = ""; composing = false }
                    }) { Text("Send to helper privately") }
                }
            }
            if (error.isNotBlank()) Text(error)
            val groups = if (helping) listOf("pairs", "received") else listOf("interests", "public_leads", "sent")
            if (groups.all { book.getJSONObject(it).length() == 0 }) {
                Text(if (helping) "Offers and requests shared with you will appear here."
                     else "Your private offers, requests and replies will appear here.")
            }
            for (group in groups) {
                val rows = book.getJSONObject(group)
                for (id in rows.keys().asSequence().sorted()) {
                    val row = rows.getJSONObject(id)
                    HorizontalDivider()
                    when (group) {
                        "sent", "received" -> {
                            Text(row.getString("summary"), style = MaterialTheme.typography.titleSmall)
                            val side = if (row.getString("side") == "offer") "Offer" else "Request"
                            val peer = row.getString("peer")
                            val name = state.people[peer]?.name ?: peer.take(8)
                            val relation = if (helping) "from" else "with"
                            val expiry = DateFormat.getDateInstance().format(Date(row.getLong("expires_at") * 1000))
                            Text("$side $relation $name · Expires $expiry")
                            if (group == "sent") {
                                TextButton({ act("withdraw", "entry" to id) }) { Text("Withdraw") }
                            } else {
                                TextButton({
                                    selected = id; candidates = emptyList(); searching = true; error = ""
                                    scope.launch {
                                        try {
                                            val result = model.privateMatchCandidates(id)
                                            if (selected == id) candidates = result
                                        } catch (e: CancellationException) { throw e }
                                        catch (e: Exception) { if (selected == id) error = e.localizedMessage ?: "Could not load matches." }
                                        finally { if (selected == id) searching = false }
                                    }
                                }, enabled = !(selected == id && searching)) { Text("Find matches") }
                                if (selected == id && !searching && error.isEmpty()) {
                                    val pairs = book.getJSONObject("pairs")
                                    val available = candidates.filter { item ->
                                        item.getString("kind") != "private" || pairs.keys().asSequence().none { proposal ->
                                            val entries = pairs.getJSONObject(proposal).getJSONArray("entries")
                                            val ids = List(entries.length()) { entries.getString(it) }
                                            id in ids && item.getString("id") in ids
                                        }
                                    }
                                    if (available.isEmpty()) Text("No new matches right now.")
                                    for (item in available) {
                                        Text(item.getString("summary"))
                                        val privateEntry = item.getString("kind") == "private"
                                        TextButton({
                                            if (privateEntry) act("suggest", "left" to id, "right" to item.getString("id"))
                                            else act("send_public", "entry" to id, "listing" to item.getString("id"))
                                        }) { Text(if (privateEntry) "Ask both privately" else "Send public listing privately") }
                                    }
                                }
                            }
                        }
                        "interests" -> {
                            Text(row.getString("summary"), style = MaterialTheme.typography.titleSmall)
                            if (!row.isNull("chat")) {
                                Text("You have been introduced.")
                                TextButton({ model.openMatchChat(row.getString("chat"), close) }) { Text("Open private chat") }
                            }
                            else if (!row.isNull("contact")) {
                                Text("You have been introduced.")
                                TextButton({ model.openConversation(row.getString("contact"), close) }) { Text("Open private chat") }
                            }
                            else if (row.isNull("vote")) {
                                Text("If you both agree, you’ll chat through a new alias made only for this match. Your profile stays private.")
                                TextButton({ act("vote", "proposal" to id, "accept" to true) }) { Text("Agree to introduction") }
                                TextButton({ act("vote", "proposal" to id, "accept" to false) }) { Text("Decline") }
                            } else Text(if (row.getBoolean("vote")) "You agreed. Waiting for the introduction." else "You declined.")
                        }
                        "pairs" -> {
                            val votes = row.getJSONArray("votes")
                            val entries = row.getJSONArray("entries")
                            Text(List(entries.length()) { book.getJSONObject("received").getJSONObject(entries.getString(it)).getString("summary") }.joinToString(" · "),
                                style = MaterialTheme.typography.titleSmall)
                            when {
                                row.getBoolean("introduced") -> Text("Introduction started")
                                (0 until votes.length()).any { !votes.isNull(it) && !votes.getBoolean(it) } -> Text("Declined")
                                votes.optBoolean(0) && votes.optBoolean(1) -> {
                                    Text("Both agreed")
                                    TextButton({ act("introduce", "proposal" to id) }) { Text("Introduce privately") }
                                }
                                else -> Text("Waiting for replies")
                            }
                        }
                        "public_leads" -> {
                            Text(row.getString("title")); Text("Public listing from your helper")
                            SelectionContainer { Text(row.getString("listing")) }
                        }
                    }
                }
            }
        }
    })
}
