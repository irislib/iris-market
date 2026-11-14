package to.iris.market

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
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
                    OutlinedTextField(helper, { helper = it }, label = { Text("Helper’s profile ID (npub…)") })
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
                            val expiry = DateFormat.getDateInstance().format(Date(row.getLong("expires_at") * 1000))
                            Text(if (helping) "$side from $name · Until $expiry" else "Your ${side.lowercase()} · Helper: $name · Until $expiry")
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
                            Text("Possible match from your helper", style = MaterialTheme.typography.labelSmall)
                            Text(row.getString("summary"), style = MaterialTheme.typography.titleSmall)
                            if (!row.isNull("chat")) {
                                Text(if (row.optBoolean("connected")) "Introduced. You can chat privately." else "Introduced. Connecting privately…")
                                TextButton({ model.openMatchChat(row.getString("chat"), close) }) {
                                    Icon(Icons.Filled.Forum, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Open private chat")
                                }
                            }
                            else if (!row.isNull("contact")) {
                                Text("You have been introduced.")
                                TextButton({ model.openConversation(row.getString("contact"), close) }) { Text("Open private chat") }
                            }
                            else if (row.isNull("vote")) {
                                Text("If you both agree, you’ll chat as private aliases. Your profile stays hidden unless you choose to share it.")
                                TextButton({ act("vote", "proposal" to id, "accept" to true) }) { Text("Agree to introduction") }
                                TextButton({ act("vote", "proposal" to id, "accept" to false) }) { Text("Decline") }
                            } else Text(if (row.getBoolean("vote")) "You agreed. Waiting for the other person and your helper." else "You declined.")
                        }
                        "pairs" -> {
                            val votes = row.getJSONArray("votes")
                            val entries = row.getJSONArray("entries")
                            Text(List(entries.length()) { book.getJSONObject("received").getJSONObject(entries.getString(it)).getString("summary") }.joinToString(" · "),
                                style = MaterialTheme.typography.titleSmall)
                            when {
                                row.getBoolean("introduced") -> Text("Introduced. They now chat privately, and you can’t see their messages.")
                                (0 until votes.length()).any { !votes.isNull(it) && !votes.getBoolean(it) } -> Text("One person declined.")
                                votes.optBoolean(0) && votes.optBoolean(1) -> {
                                    Text("Both agreed. Introducing them shares a private alias for each, not their profiles.")
                                    TextButton({ act("introduce", "proposal" to id) }) { Text("Introduce privately") }
                                }
                                (0 until votes.length()).any { !votes.isNull(it) && votes.getBoolean(it) } -> Text("One person agreed. Waiting for the other.")
                                else -> Text("Waiting for both to reply.")
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

internal fun isPrivateMatch(id: String) = id.startsWith("match:")

/** Top of an alias chat: who sees what, and an explicit, confirmed profile share. */
@Composable
internal fun PrivateMatchChatBanner(state: MarketSnapshot, model: MarketModel, busy: Boolean, chat: String, openProfile: (String) -> Unit) {
    val interest = remember(state.privateMatching, chat) {
        state.privateMatching?.let { JSONObject(it).optJSONObject("interests")?.optJSONObject(chat.removePrefix("match:")) }
    }
    val shared = interest?.optBoolean("shared_profile") == true
    val connected = interest?.optBoolean("connected") == true
    val revealed = interest?.takeUnless { it.isNull("revealed") }?.optString("revealed")
    var confirming by remember { mutableStateOf(false) }
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.TheaterComedy, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp))
                Text(if (shared) "You shared your profile in this chat." else "You appear as a private alias. They can’t see your profile.", style = MaterialTheme.typography.bodySmall)
            }
            if (revealed != null) Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.AccountCircle, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp))
                Text("They shared their profile: ${state.people[revealed]?.name ?: revealed.take(8)}", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                TextButton({ openProfile(revealed) }) { Text("View profile") }
            }
            if (!connected) Text("Connecting privately. You can write as soon as you’re connected.", style = MaterialTheme.typography.bodySmall)
            else if (!shared) TextButton({ confirming = true }, enabled = !busy && !state.demo) { Text("Share my profile…", fontWeight = FontWeight.SemiBold) }
        }
    }
    if (confirming) AlertDialog(
        onDismissRequest = { confirming = false },
        title = { Text("Share your profile?") },
        text = { Text("They’ll see your name, profile and public listings, and can find you outside this chat. This can’t be undone.") },
        confirmButton = { TextButton({
            confirming = false
            model.command(JSONObject().put("type", "private_match").put("action", JSONObject().put("op", "reveal").put("proposal", chat.removePrefix("match:"))))
        }) { Text("Share profile") } },
        dismissButton = { TextButton({ confirming = false }) { Text("Cancel") } },
    )
}

/** An alias chat is labeled by its match, never by a person. */
@Composable
internal fun PrivateMatchRow(title: String, subtitle: String?) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        val size = if (subtitle == null) 32.dp else 47.dp
        Surface(shape = MaterialTheme.shapes.extraLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.size(size)) {
            Box(contentAlignment = Alignment.Center) { Icon(Icons.Filled.TheaterComedy, null, Modifier.size(size / 2), tint = MaterialTheme.colorScheme.onPrimary) }
        }
        Spacer(Modifier.width(12.dp))
        Column {
            Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, maxLines = 1)
        }
    }
}
