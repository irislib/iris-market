package to.iris.market

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import org.json.JSONObject

@Composable fun BrowseView(state: MarketSnapshot, model: MarketModel, busy: Boolean,
    selected: (Listing) -> Unit, settings: () -> Unit) {
    var query by remember { mutableStateOf(state.query) }
    var showAll by remember { mutableStateOf(false) }
    val ai = remember(state.settings) { JSONObject(state.settings).optJSONObject("ai") }
    val canCurate = ai?.optBoolean("enabled") == true && ai.optBoolean("curate_feed") && state.error == null
    val hiddenCount = if (canCurate) state.listings.count { it.relevanceShow == false } else 0
    val visibleListings = if (canCurate && !showAll) state.listings.filter { it.relevanceShow != false } else state.listings
    LaunchedEffect(query) { delay(280); if (query != state.query) model.filter(query, state.side) }
    LazyVerticalGrid(columns = GridCells.Fixed(2), horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp), contentPadding = PaddingValues(start=22.dp,end=22.dp,bottom=90.dp)) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Column {
                Spacer(Modifier.height(14.dp))
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Text("Listings", style = MaterialTheme.typography.headlineMedium)
                    Spacer(Modifier.weight(1f))
                    IconButton(onClick = settings) { Icon(Icons.Filled.AutoAwesome, "AI settings", tint=Forest, modifier=Modifier.size(21.dp)) }
                    IconButton(onClick = { model.action("refresh") }, enabled = !busy) { Icon(Icons.Filled.Refresh, "Refresh listings", tint=Forest,modifier=Modifier.size(22.dp)) }
                }
                Spacer(Modifier.height(16.dp))
                OutlinedTextField(value = query, onValueChange = { query = it }, placeholder = { Text("Search listings") },
                    leadingIcon = { Icon(Icons.Filled.Search, null, tint = Forest) },
                    trailingIcon = if (query.isNotBlank()) {{ IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, "Clear search") } }} else null,
                    singleLine = true, shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth(),
                    colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = Line, focusedBorderColor = Forest,
                        unfocusedContainerColor = White, focusedContainerColor = White))
                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("all" to "Everything", "offer" to "Offers", "request" to "Requests").forEach { (value,label) ->
                        FilterChip(selected = state.side == value, onClick = { model.filter(query, value) }, label = { Text(label) },
                            leadingIcon = if (state.side == value) {{ Icon(Icons.Filled.Check, null, Modifier.size(16.dp)) }} else null,
                            shape = CircleShape, colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Ink,
                                selectedLabelColor = OnInk, selectedLeadingIconColor = OnInk), border = FilterChipDefaults.filterChipBorder(
                                enabled=true, selected=state.side==value, borderColor=Line, selectedBorderColor=Ink))
                    }
                }
                if (hiddenCount > 0) Surface(color = Mint, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth().padding(top = 5.dp)) {
                    Row(Modifier.padding(start = 12.dp, end = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.AutoAwesome, null, Modifier.size(16.dp), tint = Forest)
                        Spacer(Modifier.width(8.dp))
                        Text(if (showAll) "Showing all listings" else "$hiddenCount less relevant ${if (hiddenCount == 1) "listing" else "listings"} hidden",
                            Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, color = Forest)
                        TextButton(onClick = { showAll = !showAll }) { Text(if (showAll) "Use curation" else "Show all") }
                    }
                }
                if (state.error != null) Text(state.error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall,
                    modifier=Modifier.padding(vertical=6.dp))
            }
        }
        if (visibleListings.isEmpty()) item(span={GridItemSpan(maxLineSpan)}) {
            EmptyView(if(hiddenCount > 0 && !showAll) "No matching listings" else if(query.isBlank()) "No listings" else "No matches",
                if(hiddenCount > 0 && !showAll) "Show all listings or change your AI settings." else if(query.isBlank()) "Post a listing or refresh to check for new offers and requests." else "Try a different search or clear the filters.",
                Icons.Filled.Storefront)
        }
        items(visibleListings, key={it.id}) { listing -> ListingCard(listing, state.demo, {selected(listing)}, {model.save(listing.id)}) }
    }
}

@Composable fun ListingCard(listing: Listing, demo: Boolean, open: () -> Unit, save: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick=open)) {
        Box(Modifier.fillMaxWidth().aspectRatio(1.13f).clip(RoundedCornerShape(20.dp))) {
            ListingArt(listing, demo, Modifier.fillMaxSize())
            IconButton(onClick=save, modifier=Modifier.align(Alignment.TopEnd).padding(7.dp).size(34.dp)
                .background(White.copy(alpha=.92f),CircleShape)) {
                Icon(if(listing.saved) Icons.Filled.Bookmark else Icons.Filled.BookmarkBorder,
                    if(listing.saved) "Unsave ${listing.title}" else "Save ${listing.title}", tint=Ink, modifier=Modifier.size(20.dp))
            }
            if(listing.side == "request") Surface(color=Ink, shape=CircleShape,
                modifier=Modifier.align(Alignment.BottomStart).padding(9.dp)) {
                Text("WANTED", color=OnInk, style=MaterialTheme.typography.labelSmall,
                    letterSpacing=1.sp,modifier=Modifier.padding(horizontal=9.dp,vertical=4.dp))
            }
        }
        Spacer(Modifier.height(10.dp))
        Text(listing.title, fontWeight=FontWeight.Medium, fontSize=15.sp, lineHeight=20.sp,maxLines=2,overflow=TextOverflow.Ellipsis)
        Spacer(Modifier.height(5.dp))
        Row(verticalAlignment=Alignment.CenterVertically) {
            Text(listing.displayPrice, fontSize=17.sp, fontWeight=FontWeight.Bold)
            if(listing.side == "request") Text(" budget", fontSize=11.sp,color=Muted)
        }
        if(listing.location.isNotBlank()) Row(verticalAlignment=Alignment.CenterVertically,modifier=Modifier.padding(top=5.dp)) {
            Icon(Icons.Filled.LocationOn,null,Modifier.size(12.dp),tint=Muted); Spacer(Modifier.width(3.dp))
            Text(listing.location,color=Muted,fontSize=12.sp,maxLines=1,overflow=TextOverflow.Ellipsis)
        }
        listing.relevance?.takeIf { it.isNotBlank() }?.let {
            Text(it,color=Forest,fontSize=11.sp,maxLines=2,modifier=Modifier.padding(top=5.dp))
        }
    }
}

@Composable fun SavedView(state: MarketSnapshot, model: MarketModel, selected: (Listing)->Unit) {
    val saved = state.listings.filter { it.saved }
    LazyVerticalGrid(columns=GridCells.Fixed(2),horizontalArrangement=Arrangement.spacedBy(14.dp),verticalArrangement=Arrangement.spacedBy(20.dp),
        contentPadding=PaddingValues(start=22.dp,end=22.dp,bottom=90.dp)) {
        item(span={GridItemSpan(maxLineSpan)}) {
            Column(Modifier.padding(top=16.dp,bottom=10.dp)) {
                Text("Saved listings",style=MaterialTheme.typography.headlineMedium)
            }
        }
        if(saved.isEmpty()) item(span={GridItemSpan(maxLineSpan)}) {
            EmptyView("No saved listings","Tap the bookmark on a listing to keep it here.",Icons.Filled.Bookmark)
        }
        items(saved,key={it.id}) { item -> ListingCard(item,state.demo,{selected(item)},{model.save(item.id)}) }
    }
}

@Composable fun ListingDetail(listing: Listing, demo: Boolean, model: MarketModel, busy: Boolean, inbox:()->Unit) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal=24.dp).padding(bottom=30.dp)) {
        ListingArt(listing,demo,Modifier.fillMaxWidth().height(245.dp).clip(RoundedCornerShape(24.dp)))
        Spacer(Modifier.height(22.dp))
        Text(listing.category.uppercase(),color=Forest,style=MaterialTheme.typography.labelSmall,letterSpacing=1.5.sp)
        Spacer(Modifier.height(8.dp));Text(listing.title,style=MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(9.dp));Text(listing.displayPrice,fontSize=29.sp,fontWeight=FontWeight.SemiBold)
        if(listing.location.isNotBlank()) Row(Modifier.padding(top=12.dp),verticalAlignment=Alignment.CenterVertically) {
            Icon(Icons.Filled.LocationOn,null,Modifier.size(17.dp),tint=Muted);Spacer(Modifier.width(5.dp));Text(listing.location,color=Muted)
        }
        Spacer(Modifier.height(22.dp));HorizontalDivider(color=Line);Spacer(Modifier.height(21.dp))
        Text(listing.description,style=MaterialTheme.typography.bodyLarge)
        Spacer(Modifier.height(24.dp))
        if(demo) Text("Sample listing · Preview stays on this device.",color=Muted,style=MaterialTheme.typography.bodySmall)
        else if(listing.mine) Text("Your listing · ${listing.delivery.ifBlank { listing.status }}",color=Muted,style=MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement=Arrangement.spacedBy(10.dp)) {
            OutlinedButton(onClick={model.save(listing.id)},modifier=Modifier.weight(1f).height(51.dp),shape=RoundedCornerShape(15.dp)) {
                Icon(if(listing.saved) Icons.Filled.Bookmark else Icons.Filled.BookmarkBorder,null,Modifier.size(18.dp));Spacer(Modifier.width(6.dp))
                Text(if(listing.saved) "Saved" else "Save")
            }
            Button(enabled=!busy&&!demo&&!listing.mine,onClick={
                model.command(JSONObject().put("type","contact").put("author",listing.author).put("listing_id",listing.id),inbox)
            },modifier=Modifier.weight(1.35f).height(51.dp),shape=RoundedCornerShape(15.dp)) {
                Text("Private enquiry")
            }
        }
        if(listing.mine && !demo) TextButton(enabled=!busy,onClick={model.command(JSONObject().put("type","close").put("id",listing.id))}) { Text("Close listing") }
    }
}
