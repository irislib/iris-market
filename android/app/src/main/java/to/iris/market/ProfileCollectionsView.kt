package to.iris.market

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject

@Composable
internal fun ProfileCollectionsView(author: String, feed: ProfileListings?, state: MarketSnapshot, model: MarketModel, open: (Listing) -> Unit) {
    val owner = author == state.publicKey && state.canSign && !state.demo
    var expanded by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf(false) }
    var original by remember { mutableStateOf<ProfileCollection?>(null) }
    if (editing && owner) {
        CollectionEditor(original, feed, state, model, author) { editing = false }
        return
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Collections", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            if (owner) TextButton(onClick = { original = null; editing = true }) { Text("New collection") }
        }
        if (feed?.collectionsError != null) {
            Text(feed.collectionsError, style = MaterialTheme.typography.bodySmall, color = Muted)
            TextButton(onClick = { model.command(JSONObject().put("type","load_profile").put("author",author)) }) { Text("Retry") }
        } else if (feed?.collections.isNullOrEmpty()) {
            Text("No public collections yet.", color = Muted)
        }
        feed?.collections.orEmpty().forEach { collection ->
            val isOpen = expanded == collection.identifier
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.fillMaxWidth().clickable {
                    expanded = if (isOpen) null else collection.identifier
                    model.openCollection(author, expanded)
                }.padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(collection.title, style = MaterialTheme.typography.titleMedium)
                        val count = collection.members.size
                        Text(if (collection.delivery == "queued") "Queued to publish" else "$count ${if (count == 1) "listing" else "listings"}",
                            style = MaterialTheme.typography.bodySmall, color = Muted)
                    }
                    Icon(if (isOpen) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, if (isOpen) "Collapse collection" else "Open collection")
                }
                if (isOpen) {
                    if (owner) TextButton(onClick = { original = collection; editing = true }) { Text("Edit collection") }
                    collection.members.forEach { member ->
                        val listing = member.listing
                        if (listing != null) {
                            ListingCard(listing, state.demo, { open(listing) }, { model.save(listing.id) }, compact = true)
                            val seller = state.people[listing.author] ?: PublicPerson.unnamed(listing.author)
                            Text("Listed by ${seller.displayName}", style = MaterialTheme.typography.bodySmall, color = Muted)
                        }
                    }
                    val missing = collection.members.count { it.listing == null }
                    if (missing > 0) Text(if (missing == 1) "1 listing unavailable" else "$missing listings unavailable",
                        style = MaterialTheme.typography.bodySmall, color = Muted)
                }
                HorizontalDivider()
            }
        }
    }
}

@Composable
private fun CollectionEditor(original: ProfileCollection?, feed: ProfileListings?, state: MarketSnapshot, model: MarketModel, author: String, cancel: () -> Unit) {
    var title by remember { mutableStateOf(original?.title.orEmpty()) }
    var selected by remember { mutableStateOf(original?.members.orEmpty().map { it.id }) }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val eligible = (feed?.listings.orEmpty() + state.savedListings.orEmpty()).filter { it.status == "active" && it.id.startsWith(it.author + ":") }
    val current = feed?.collections?.firstOrNull { it.eventId == original?.eventId } ?: original
    val candidates = (current?.members.orEmpty() + eligible.map { ProfileCollection.Member(it.id, it) }).distinctBy { it.id }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(if (original == null) "New collection" else "Edit collection", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth(), label = { Text("Collection name") }, singleLine = true, enabled = !submitting)
        val name = title.trim()
        val tooLong = name.codePointCount(0, name.length) > 160
        if (tooLong) Text("Use a name of 160 characters or fewer.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        Text("Choose from your listings and saved items. Only the items you select will appear in this public collection.",
            style = MaterialTheme.typography.bodyMedium, color = Muted)
        if (candidates.isEmpty()) Text("Save a listing or post your own to start a collection.")
        candidates.forEach { member ->
            val checked = member.id in selected
            Row(Modifier.fillMaxWidth().toggleable(value = checked, role = Role.Checkbox,
                enabled = !submitting && (checked || selected.size < 64),
                onValueChange = { selected = if (checked) selected - member.id else selected + member.id })
                .padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Checkbox(checked, onCheckedChange = null)
                Column {
                    Text(member.listing?.title ?: "Unavailable listing", style = MaterialTheme.typography.bodyMedium)
                    member.listing?.let {
                        val seller = state.people[it.author] ?: PublicPerson.unnamed(it.author)
                        Text(seller.displayName, style = MaterialTheme.typography.bodySmall, color = Muted)
                    }
                }
            }
        }
        if (selected.size == 64) Text("64 listings selected · collection limit reached.", style = MaterialTheme.typography.bodySmall, color = Muted)
        if (feed?.canLoadMore == true) TextButton(enabled = !submitting && !feed.loading,
            onClick = { model.command(JSONObject().put("type","load_more_profile_listings").put("author",author)) }) { Text("Load more of my listings") }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = cancel, enabled = !submitting) { Text("Cancel") }
            Button(enabled = !submitting && name.isNotEmpty() && !tooLong && selected.isNotEmpty(), onClick = {
                val request = JSONObject().put("type","save_collection").put("title",name).put("listing_ids",JSONArray(selected))
                original?.let { request.put("identifier",it.identifier).put("previous_event_id",it.eventId) }
                submitting = true
                error = null
                model.saveCollection(author, request, { submitting = false; cancel() }, { submitting = false; error = it })
            }) { Text("Publish collection") }
        }
    }
}
