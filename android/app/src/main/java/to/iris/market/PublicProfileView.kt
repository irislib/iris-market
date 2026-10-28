package to.iris.market

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

@Composable fun ConnectionBadge(connection: PublicConnection) {
    connection.badge?.let { badge ->
        Icon(Icons.Filled.Verified, connection.description, Modifier.size(19.dp),
            tint=when(badge) { "following" -> Color(0xFF4387CA); "trusted" -> Color(0xFFD39E32); else -> Muted })
    } ?: connection.distance?.let { Text("$it hops",color=Muted,style=MaterialTheme.typography.labelSmall) }
}
@Composable fun PublicProfileView(initialAuthor: String, state: MarketSnapshot, model: MarketModel, openListing:(Listing)->Unit, close:()->Unit) {
    var author by remember(initialAuthor) { mutableStateOf(initialAuthor) }
    var history by remember { mutableStateOf(emptyList<String>()) }
    var selection by remember { mutableIntStateOf(0) }
    val uri=LocalUriHandler.current
    LaunchedEffect(author) { model.command(JSONObject().put("type","load_profile").put("author",author)) }
    val profile=state.profile?.takeIf { it.person.author==author }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal=23.dp).padding(bottom=30.dp),verticalArrangement=Arrangement.spacedBy(18.dp)) {
        Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
            if(history.isNotEmpty()) TextButton(onClick={author=history.last();history=history.dropLast(1)}) { Text("Back") }
            Text("Profile",style=MaterialTheme.typography.titleLarge,modifier=Modifier.weight(1f))
            TextButton(onClick=close) { Text("Done") }
        }
        if(profile==null) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
        else {
            Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(14.dp)) {
                UserAvatar(profile.person,64.dp)
                Column(Modifier.weight(1f)) {
                    UserName(profile.person,style=MaterialTheme.typography.titleLarge)
                    Text(profile.person.connection.description,color=Muted,style=MaterialTheme.typography.bodySmall)
                }
            }
            if(profile.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            if(profile.about.isNotBlank()) Text(profile.about,style=MaterialTheme.typography.bodyMedium)
            profile.website?.let { url -> TextButton(onClick={runCatching{uri.openUri(url)}}) { Text(url,maxLines=2) } }
            val authorListings=state.listings.filter{it.author==author}
            if(authorListings.isNotEmpty()) {
                Text("Listings in this feed",style=MaterialTheme.typography.titleMedium)
                authorListings.forEach { listing -> Row(Modifier.fillMaxWidth().clickable{openListing(listing)}.padding(vertical=5.dp)) {Text(listing.title,Modifier.weight(1f));Text(listing.displayPrice,fontWeight=FontWeight.Medium)} }
            }
            Text(profile.graphLabel,color=Forest,style=MaterialTheme.typography.labelMedium)
            if(!profile.loading && (!profile.graphLoaded || profile.error != null)) Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                Text("Some connections are unavailable.",color=Muted,style=MaterialTheme.typography.bodySmall,modifier=Modifier.weight(1f))
                TextButton(onClick={model.command(JSONObject().put("type","load_profile").put("author",author))}) { Text("Retry") }
            }
            Row(horizontalArrangement=Arrangement.spacedBy(6.dp)) {
                listOf("Known ${profile.known.size}","Following ${profile.followingCount}","Followers ${profile.followers.size}+").forEachIndexed { i,label ->
                    FilterChip(selected=selection==i,onClick={selection=i},label={Text(label,style=MaterialTheme.typography.labelSmall)})
                }
            }
            val people=when(selection) { 1->profile.following;2->profile.followers;else->profile.known }
            if(people.isEmpty()) Text(if(profile.loading) "Loading…" else "No connections to show.",color=Muted,style=MaterialTheme.typography.bodyMedium)
            people.forEach { person ->
                Row(Modifier.fillMaxWidth().clickable{history=history+author;author=person.author}.padding(vertical=5.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                    UserRow(person,person.connection.description)

                }
            }
        }
    }
}
