package to.iris.market

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.state.ToggleableState
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
    selected: (Listing) -> Unit, settings: () -> Unit, photoFilter: Boolean?, changePhotoFilter: (Boolean?) -> Unit) {
    var query by remember { mutableStateOf(state.query) }
    var showAll by remember { mutableStateOf(false) }
    var showMap by remember { mutableStateOf(false) }
    var sortMenu by remember { mutableStateOf(false) }
    var filtersMenu by remember { mutableStateOf(false) }
    val ai = remember(state.settings) { JSONObject(state.settings).optJSONObject("ai") }
    val localModel by model.localModelState.collectAsState()
    val localInference = ai?.optString("provider")=="litert" && localModel.phase in setOf(LocalModelPhase.VERIFYING, LocalModelPhase.LOADING, LocalModelPhase.REVIEWING)
    val localReady = NativeAIReadiness.localReady(localModel.phase)
    val aiSearch = NativeAIReadiness.isOn(ai?.optBoolean("enabled")==true,ai?.optString("provider") ?: "",ai?.optString("model") ?: "",ai?.optString("base_url") ?: "",localReady,state.demo)
    val canCurate = ai?.optBoolean("enabled") == true && state.aiSearch && state.error == null
    val hiddenCount = if (canCurate) state.listings.count { it.relevanceShow == false } else 0
    val wantsPhotos = NativePhotoFilter.wantsPhotos(photoFilter,state.query,state.side,showMap)
    val visibleListings = state.listings.filter { listing ->
        (!canCurate || showAll || listing.relevanceShow != false) && NativePhotoFilter.includes(listing.imageUrl,photoFilter,state.query,state.side,showMap)
    }
    LazyVerticalGrid(columns = GridCells.Fixed(2), horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp), contentPadding = PaddingValues(start=22.dp,end=22.dp,bottom=90.dp)) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Column {
                Spacer(Modifier.height(14.dp))
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Text("Listings", style = MaterialTheme.typography.headlineMedium)
                    Spacer(Modifier.weight(1f))
                    Box {
                        IconButton(onClick = { sortMenu = true }) { Icon(Icons.Filled.Sort,"Sort listings",tint=Forest) }
                        DropdownMenu(expanded=sortMenu,onDismissRequest={sortMenu=false}) {
                            listOf("suggested" to "Relevance", "newest" to "Newest").forEach { (value,label) -> DropdownMenuItem(text={Text(label)},onClick={model.command(JSONObject().put("type","set_sort").put("sort",value));sortMenu=false}) }
                        }
                    }
                    IconButton(onClick={showMap=!showMap}, enabled=!state.demo) { Icon(if(showMap) Icons.Filled.GridView else Icons.Filled.Map,if(showMap) "Show grid" else "Show map",tint=Forest) }
                    IconButton(onClick = { model.action("refresh") }, enabled = !busy) { Icon(Icons.Filled.Refresh, "Refresh listings", tint=Forest,modifier=Modifier.size(22.dp)) }
                }
                Spacer(Modifier.height(16.dp))
                OutlinedTextField(value = query, onValueChange = { query = it }, placeholder = { Text("Search listings") },
                    leadingIcon = { Icon(Icons.Filled.Search, null, tint = Forest) },
                    trailingIcon = { Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(48.dp).combinedClickable(enabled=!busy||ai?.optBoolean("enabled")==true,role=Role.Switch,onClick={showAll=false;model.toggleAI(settings)},onLongClick=settings,onLongClickLabel="Open AI settings")
                            .semantics { contentDescription="AI search";stateDescription=if(ai?.optBoolean("enabled")==true) { if(ai?.optString("provider")=="litert"&&localModel.phase==LocalModelPhase.VERIFYING) "On, checking" else if(aiSearch) "On" else "On, unavailable" } else "Off";toggleableState=if(ai?.optBoolean("enabled")==true) ToggleableState.On else ToggleableState.Off },contentAlignment=Alignment.Center) {
                            if(busy||localInference) CircularProgressIndicator(Modifier.size(20.dp),strokeWidth=2.dp)
                            else Icon(Icons.Filled.AutoAwesome,null,tint=if(aiSearch) Forest else Muted)
                        }
                        if(query.isNotBlank()) IconButton(onClick={query="";model.filter("",state.side)},modifier=Modifier.size(36.dp)) { Icon(Icons.Filled.Close,"Clear search") }
                    } },
                    keyboardOptions=KeyboardOptions(imeAction=ImeAction.Search), keyboardActions=KeyboardActions(onSearch={when(NativeAIReadiness.searchAction(ai?.optBoolean("enabled")==true,aiSearch,busy,localInference,query)) {
                        NativeAISearchAction.WAIT -> Unit
                        NativeAISearchAction.SETTINGS -> settings()
                        NativeAISearchAction.AI -> model.searchAI(query,state.side)
                        NativeAISearchAction.TEXT -> model.filter(query,state.side)
                    }}),
                    singleLine = true, shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth(),
                    colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = Line, focusedBorderColor = Forest,
                        unfocusedContainerColor = White, focusedContainerColor = White))
                if(ai?.optString("provider")=="litert"&&!localModel.available&&!localInference) {
                    Text("The on-device model is not ready. Open AI settings to download or check it.",color=Muted,style=MaterialTheme.typography.bodySmall)
                }
                if(localInference) Column(Modifier.fillMaxWidth()) {
                    if(localModel.phase==LocalModelPhase.REVIEWING && localModel.total>0) {
                        LinearProgressIndicator(progress={localModel.reviewed.toFloat()/localModel.total},modifier=Modifier.fillMaxWidth())
                    } else LinearProgressIndicator(modifier=Modifier.fillMaxWidth())
                    Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                        Text(when(localModel.phase) {
                            LocalModelPhase.VERIFYING -> "Checking model"
                            LocalModelPhase.LOADING -> "Loading model"
                            else -> "Reviewing ${localModel.reviewed} of ${localModel.total}"
                        },Modifier.weight(1f),color=Muted,style=MaterialTheme.typography.bodySmall)
                        TextButton(onClick=model::cancelLocalAI) { Icon(Icons.Filled.Stop,null,Modifier.size(16.dp));Spacer(Modifier.width(6.dp));Text("Stop") }
                    }
                }
                Spacer(Modifier.height(14.dp))
                Row(Modifier.fillMaxWidth(),horizontalArrangement = Arrangement.spacedBy(8.dp),verticalAlignment=Alignment.CenterVertically) {
                    listOf("offer" to "Selling", "request" to "Buying").forEach { (value,label) ->
                        FilterChip(selected = state.side == value, onClick = { model.filter(state.query, value, state.aiSearch) }, label = { Text(label) },
                            leadingIcon = if (state.side == value) {{ Icon(Icons.Filled.Check, null, Modifier.size(16.dp)) }} else null,
                            shape = CircleShape, colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Action,
                                selectedLabelColor = OnInk, selectedLeadingIconColor = OnInk), border = FilterChipDefaults.filterChipBorder(
                                enabled=true, selected=state.side==value, borderColor=Line, selectedBorderColor=Action))
                    }
                    Spacer(Modifier.weight(1f))
                    Box {
                        IconButton(onClick={filtersMenu=true}) { Icon(Icons.Filled.FilterAlt,"Filters",tint=Muted) }
                        DropdownMenu(expanded=filtersMenu,onDismissRequest={filtersMenu=false}) {
                            DropdownMenuItem(text={Text("Has photos")},leadingIcon={if(wantsPhotos) Icon(Icons.Filled.Check,null)},onClick={changePhotoFilter(true);filtersMenu=false})
                            DropdownMenuItem(text={Text("Show all listings")},onClick={changePhotoFilter(false);filtersMenu=false})
                            DropdownMenuItem(text={Text("Automatic")},onClick={changePhotoFilter(null);filtersMenu=false})
                        }
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
                if (state.error != null) Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                    Text("Couldn’t complete that action.",color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall,modifier=Modifier.weight(1f))
                    TextButton(onClick=settings) { Text("Settings") }
                }
            }
        }
        if (showMap && !state.demo) item(span={GridItemSpan(maxLineSpan)}) {
            MarketMapView(visibleListings,selected,Modifier.fillMaxWidth().height(440.dp).clip(RoundedCornerShape(20.dp)))
        }
        if (!showMap && visibleListings.isEmpty()) item(span={GridItemSpan(maxLineSpan)}) {
            EmptyView(if(hiddenCount > 0 && !showAll) "No matching listings" else if(query.isBlank()) "No listings" else "No matches",
                if(hiddenCount > 0 && !showAll) "Show all listings or change your AI settings." else if(query.isBlank()) "Sell something or post what you want to buy." else "Try a different search or clear the filters.",
                Icons.Filled.Storefront)
        }
        if(!showMap) items(visibleListings, key={it.id}) { listing -> ListingCard(listing, state.demo, {selected(listing)}, {model.save(listing.id)}) }
    }
}

@Composable fun ListingCard(listing: Listing, demo: Boolean, open: () -> Unit, save: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick=open)) {
        Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(20.dp))) {
            ListingArt(listing, demo, Modifier.fillMaxSize())
            IconButton(onClick=save, modifier=Modifier.align(Alignment.TopEnd).padding(7.dp).size(34.dp)
                .background(White.copy(alpha=.92f),CircleShape)) {
                Icon(if(listing.saved) Icons.Filled.Favorite else Icons.Filled.FavoriteBorder,
                    if(listing.saved) "Unsave ${listing.title}" else "Save ${listing.title}", tint=Ink, modifier=Modifier.size(20.dp))
            }
            if(listing.side == "request") Surface(color=Action, shape=CircleShape,
                modifier=Modifier.align(Alignment.BottomStart).padding(9.dp)) {
                Text("BUYING", color=OnInk, style=MaterialTheme.typography.labelSmall,
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
    val saved = state.savedListings ?: state.listings.filter { it.saved }
    LazyVerticalGrid(columns=GridCells.Fixed(2),horizontalArrangement=Arrangement.spacedBy(14.dp),verticalArrangement=Arrangement.spacedBy(20.dp),
        contentPadding=PaddingValues(start=22.dp,end=22.dp,bottom=90.dp)) {
        item(span={GridItemSpan(maxLineSpan)}) {
            Column(Modifier.padding(top=16.dp,bottom=10.dp)) {
                Text("Saved listings",style=MaterialTheme.typography.headlineMedium)
            }
        }
        if(saved.isEmpty()) item(span={GridItemSpan(maxLineSpan)}) {
            EmptyView("No saved listings","Tap the heart on a listing to keep it here.",Icons.Filled.Favorite)
        }
        items(saved,key={it.id}) { item -> ListingCard(item,state.demo,{selected(item)},{model.save(item.id)}) }
    }
}

@Composable fun ListingDetail(listing: Listing, demo: Boolean, model: MarketModel, busy: Boolean, person: PublicPerson?, openProfile:(String)->Unit, buy:()->Unit, inbox:()->Unit) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal=24.dp).padding(bottom=30.dp)) {
        ListingArt(listing,demo,Modifier.fillMaxWidth().height(245.dp).clip(RoundedCornerShape(24.dp)))
        Spacer(Modifier.height(22.dp))
        Text(listing.category.uppercase(),color=Forest,style=MaterialTheme.typography.labelSmall,letterSpacing=1.5.sp)
        Spacer(Modifier.height(8.dp));Text(listing.title,style=MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(9.dp));Text(listing.displayPrice,fontSize=29.sp,fontWeight=FontWeight.SemiBold)
        if(listing.location.isNotBlank()) Row(Modifier.padding(top=12.dp),verticalAlignment=Alignment.CenterVertically) {
            Icon(Icons.Filled.LocationOn,null,Modifier.size(17.dp),tint=Muted);Spacer(Modifier.width(5.dp));Text(listing.location,color=Muted)
        }
        TextButton(onClick={openProfile(listing.author)},modifier=Modifier.fillMaxWidth().padding(top=12.dp).semantics { contentDescription = "View author" }) {
            UserRow(person ?: PublicPerson.unnamed(listing.author))
        }
        Spacer(Modifier.height(22.dp));HorizontalDivider(color=Line);Spacer(Modifier.height(21.dp))
        Text(listing.description,style=MaterialTheme.typography.bodyLarge)
        Spacer(Modifier.height(24.dp))
        if(demo) Text("Sample listing · Preview stays on this device.",color=Muted,style=MaterialTheme.typography.bodySmall)
        else if(listing.mine) Text(if(listing.delivery == "queued") "Your listing · Waiting to send" else if(listing.delivery == "failed") "Your listing · Not sent" else "Your listing",color=Muted,style=MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement=Arrangement.spacedBy(10.dp)) {
            OutlinedButton(onClick={model.save(listing.id)},modifier=Modifier.weight(1f).height(51.dp),shape=RoundedCornerShape(15.dp)) {
                Icon(if(listing.saved) Icons.Filled.Favorite else Icons.Filled.FavoriteBorder,null,Modifier.size(18.dp));Spacer(Modifier.width(6.dp))
                Text(if(listing.saved) "Saved" else "Save")
            }
            Button(enabled=!busy&&!demo&&!listing.mine,onClick={
                if(listing.side=="offer") buy() else model.command(JSONObject().put("type","contact").put("author",listing.author).put("listing_id",listing.id),inbox)
            },modifier=Modifier.weight(1.35f).height(51.dp),shape=RoundedCornerShape(15.dp)) {
                Text(if(listing.side=="offer") "Buy" else "Respond")
            }
        }
        if(!listing.mine && !demo && listing.side=="offer") TextButton(enabled=!busy,onClick={
            model.command(JSONObject().put("type","contact").put("author",listing.author).put("listing_id",listing.id),inbox)
        },modifier=Modifier.fillMaxWidth()) { Text("Message") }
        if(listing.mine && !demo) TextButton(enabled=!busy,onClick={model.command(JSONObject().put("type","close").put("id",listing.id))}) { Text("Close listing") }
    }
}
