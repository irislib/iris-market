package to.iris.market

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@Composable fun ConnectionBadge(connection: PublicConnection) {
    connection.badge?.let { badge ->
        Icon(Icons.Filled.Verified, connection.description, Modifier.size(19.dp),
            tint=when(badge) { "following" -> Color(0xFF4387CA); "trusted" -> Color(0xFFD39E32); else -> Muted })
    } ?: connection.distance?.let { Text("$it away",color=Muted,style=MaterialTheme.typography.labelSmall) }
}

@Composable fun PublicProfileView(initialAuthor: String, state: MarketSnapshot, model: MarketModel, openListing:(Listing)->Unit, message:(String)->Unit = {}, close:()->Unit) {
    var author by remember(initialAuthor) { mutableStateOf(initialAuthor) }
    var history by remember(initialAuthor) { mutableStateOf(emptyList<String>()) }
    var selection by remember(author) { mutableIntStateOf(0) }
    val uri=LocalUriHandler.current
    val gridState=rememberLazyGridState()
    LaunchedEffect(author) {
        gridState.scrollToItem(0)
        model.command(JSONObject().put("type","load_profile").put("author",author))
    }
    DisposableEffect(author) {
        val openedAuthor=author
        onDispose { model.command(JSONObject().put("type","cancel_profile_followers").put("author",openedAuthor)); model.command(JSONObject().put("type","close_profile").put("author",openedAuthor)) }
    }
    val profile=state.profile?.takeIf { it.person.author==author }
    val person=profile?.person ?: state.people[author] ?: PublicPerson.unnamed(author)
    val feed=state.profileListings?.takeIf { it.author==author }
    val authorListings=feed?.listings ?: emptyList()
    val people=when(selection) { 1->profile?.known;2->profile?.following;3->profile?.followers;else->null } ?: emptyList()
    val retryListings={model.command(JSONObject().put("type",if(feed==null) "load_profile" else "load_more_profile_listings").put("author",author));Unit}
    LazyVerticalGrid(columns=GridCells.Fixed(2),state=gridState,modifier=Modifier.fillMaxWidth(),
        horizontalArrangement=Arrangement.spacedBy(14.dp),verticalArrangement=Arrangement.spacedBy(18.dp),
        contentPadding=PaddingValues(start=23.dp,end=23.dp,bottom=32.dp)) {
        item(span={GridItemSpan(maxLineSpan)}) {
            Column(verticalArrangement=Arrangement.spacedBy(14.dp)) {
                Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                    if(history.isNotEmpty()) IconButton(onClick={author=history.last();history=history.dropLast(1)}) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack,"Back")
                    }
                    Text("Profile",style=MaterialTheme.typography.titleLarge,modifier=Modifier.weight(1f))
                    TextButton(onClick=close) { Text("Done") }
                }
                Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(14.dp)) {
                    UserAvatar(person,64.dp)
                    Column(Modifier.weight(1f)) {
                        UserName(person,style=MaterialTheme.typography.titleLarge)
                        Text(if(person.connection.distance==null) "No known connections" else person.connection.description,color=Muted,style=MaterialTheme.typography.bodySmall)
                    }
                }
                if(!state.demo && author!=state.publicKey) OutlinedButton(onClick={message(author)}) {
                    Icon(Icons.Filled.ChatBubble,null);Spacer(Modifier.width(8.dp));Text("Message")
                }
                if(profile?.loading==true) LinearProgressIndicator(Modifier.fillMaxWidth())
                if(!profile?.about.isNullOrBlank()) Text(profile!!.about,style=MaterialTheme.typography.bodyMedium)
                profile?.website?.let { url -> TextButton(onClick={runCatching{uri.openUri(url)}}) { Text(url,maxLines=2) } }
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(6.dp)) {
                    val labels=listOf("Listings",profile?.let{"Known ${it.known.size}"}?:"Known",profile?.let{"Following ${it.followingCount}"}?:"Following",profile?.takeIf{it.followersLoaded}?.let{"Followers ${it.followers.size}"}?:"Followers")
                    labels.forEachIndexed { index,label ->
                        FilterChip(selected=selection==index,onClick={
                            if(selection==3 && index!=3) model.command(JSONObject().put("type","cancel_profile_followers").put("author",author))
                            selection=index
                            if(index==3 && profile?.followersLoaded!=true && profile?.followersLoading!=true) model.command(JSONObject().put("type","load_profile_followers").put("author",author))
                        },label={Text(label,style=MaterialTheme.typography.labelSmall)})
                    }
                }
            }
        }
        if(selection==0) {
            items(authorListings,key={it.id}) { listing ->
                ListingCard(listing,state.demo,{openListing(listing)},{model.save(listing.id)})
            }
            item(span={GridItemSpan(maxLineSpan)}) {
                Column(Modifier.fillMaxWidth(),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.spacedBy(10.dp)) {
                    if(feed==null || feed.loading) {
                        LinearProgressIndicator(Modifier.fillMaxWidth())
                        Text("Loading listings…",color=Muted,style=MaterialTheme.typography.bodySmall)
                    } else if(feed.error!=null) {
                        Text("Couldn’t load listings.",color=Muted,style=MaterialTheme.typography.bodySmall)
                        TextButton(onClick=retryListings) { Text("Retry") }
                    } else if(authorListings.isEmpty()) {
                        Text("No listings yet.",color=Muted,style=MaterialTheme.typography.bodyMedium)
                    }
                    if(feed?.canLoadMore==true && feed.error==null) OutlinedButton(
                        onClick={model.command(JSONObject().put("type","load_more_profile_listings").put("author",author))},enabled=!feed.loading
                    ) { Text("Load more") }
                }
            }
        } else {
            if(selection==3 && profile?.followersLoading==true) item(span={GridItemSpan(maxLineSpan)}) { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            if(selection==3 && profile?.followersError!=null) item(span={GridItemSpan(maxLineSpan)}) {
                Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) { Text(profile.followersError,color=Muted,modifier=Modifier.weight(1f)); TextButton(onClick={model.command(JSONObject().put("type","load_profile_followers").put("author",author))}){Text("Retry")} }
            }
            if(selection!=3 && (profile==null || profile.loading || profile.error!=null || !profile.graphLoaded)) item(span={GridItemSpan(maxLineSpan)}) {
                Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                    Text(if(profile==null || profile.loading) "Loading connections…" else if(state.demo && profile.error!=null) profile.error else "Some connections are unavailable.",color=Muted,style=MaterialTheme.typography.bodySmall,modifier=Modifier.weight(1f))
                    if(profile!=null && !profile.loading && !state.demo) TextButton(onClick={model.command(JSONObject().put("type","load_profile").put("author",author))}) { Text("Retry") }
                }
            }
            if(people.isEmpty() && profile!=null && !(if(selection==3) profile.followersLoading else profile.loading)) item(span={GridItemSpan(maxLineSpan)}) {
                Text("No connections to show.",color=Muted,style=MaterialTheme.typography.bodyMedium)
            }
            items(people,key={it.author},span={GridItemSpan(maxLineSpan)}) { connection ->
                Row(Modifier.fillMaxWidth().clickable{history=history+author;author=connection.author}.padding(vertical=5.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                    UserRow(connection,connection.connection.description)
                }
            }
        }
    }
}
