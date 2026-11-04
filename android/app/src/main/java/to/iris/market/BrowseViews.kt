package to.iris.market

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import org.json.JSONObject

@Composable
private fun rememberListLayout(): MutableState<Boolean> {
    val context = LocalContext.current
    val prefs = remember(context) { context.getSharedPreferences("market-browse", android.content.Context.MODE_PRIVATE) }
    val choice = remember(prefs) { mutableStateOf(prefs.getBoolean("listLayout", false)) }
    LaunchedEffect(choice.value) { prefs.edit().putBoolean("listLayout", choice.value).apply() }
    return choice
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun BrowseView(state: MarketSnapshot, model: MarketModel, busy: Boolean,
    selected: (Listing) -> Unit, settings: () -> Unit, photoFilter: Boolean?, changePhotoFilter: (Boolean?) -> Unit) {
    var query by remember { mutableStateOf(state.query) }
    val showAll = state.showAllResults
    var listLayout by rememberListLayout()
    var showMap by remember { mutableStateOf(false) }
    var sortMenu by remember { mutableStateOf(false) }
    var filtersSheet by remember { mutableStateOf(false) }
    DisposableEffect(Unit) { model.setBrowseVisible(true); onDispose { model.setBrowseVisible(false) } }
    val ai = remember(state.settings) { JSONObject(state.settings).optJSONObject("ai") }
    val localModel by model.localModelState.collectAsState()
    val localInference = NativeAIReadiness.isLocal(ai?.optString("provider")) && localModel.phase in setOf(LocalModelPhase.VERIFYING, LocalModelPhase.LOADING, LocalModelPhase.REVIEWING)
    val localReady = NativeAIReadiness.localReady(localModel.phase)
    val aiSearch = NativeAIReadiness.isOn(ai?.optBoolean("enabled")==true,ai?.optString("provider") ?: "",ai?.optString("model") ?: "",ai?.optString("base_url") ?: "",localReady,state.demo)
    val homeFeed = model.homeFilterActive()
    val canCurate = homeFeed || ai?.optBoolean("enabled") == true && state.aiSearch && state.query.isNotBlank()
    val searching = localInference || state.searchDiscovery?.loading == true || canCurate && busy
    val matchCount = state.listings.count { it.matchesSearch }
    val wantsPhotos = NativePhotoFilter.wantsPhotos(photoFilter,state.query,state.side,showMap)
    val visibleListings = state.listings.filter { listing ->
        (!canCurate || showAll || listing.matchesSearch) && NativePhotoFilter.includes(listing.imageUrl,photoFilter,state.query,state.side,showMap,listing.isBitcoinOffer)
    }
    LazyVerticalGrid(columns = GridCells.Fixed(if(listLayout) 1 else 2), horizontalArrangement = Arrangement.spacedBy(14.dp),
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
                    if(!showMap) TextButton(onClick={listLayout=!listLayout}) { Text(if(listLayout) "Grid" else "List") }
                    TextButton(onClick={showMap=!showMap}, enabled=!state.demo) { Text(if(showMap) "Listings" else "Map") }
                    IconButton(onClick = { model.action("refresh") }, enabled = !busy) { Icon(Icons.Filled.Refresh, "Refresh listings", tint=Forest,modifier=Modifier.size(22.dp)) }
                }
                Spacer(Modifier.height(16.dp))
                OutlinedTextField(value = query, onValueChange = { query = it }, placeholder = { Text("Search listings") },
                    leadingIcon = { Icon(Icons.Filled.Search, null, tint = Forest) },
                    trailingIcon = { Row(verticalAlignment = Alignment.CenterVertically) {
                        if(query.isNotBlank()) IconButton(onClick={query="";model.filter("",state.side)},modifier=Modifier.size(36.dp)) { Icon(Icons.Filled.Close,"Clear search") }
                    } },
                    keyboardOptions=KeyboardOptions(imeAction=ImeAction.Search), keyboardActions=KeyboardActions(onSearch={when(NativeAIReadiness.searchAction(!showAll&&ai?.optBoolean("enabled")==true,aiSearch,busy,localInference,query)) {
                        NativeAISearchAction.WAIT -> Unit
                        NativeAISearchAction.SETTINGS -> settings()
                        NativeAISearchAction.AI -> model.searchAI(query,state.side)
                        NativeAISearchAction.TEXT -> model.filter(query,state.side)
                    }}),
                    singleLine = true, shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth(),
                    colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = Line, focusedBorderColor = Forest,
                        unfocusedContainerColor = White, focusedContainerColor = White))
                if(NativeAIReadiness.isLocal(ai?.optString("provider"))&&!localModel.available&&!localInference) {
                    Text("The on-device model is not ready. Open AI settings to download or check it.",color=Muted,style=MaterialTheme.typography.bodySmall)
                }
                if(searching) Column(Modifier.fillMaxWidth()) {
                    if(localModel.phase==LocalModelPhase.REVIEWING && localModel.total>0) {
                        LinearProgressIndicator(progress={localModel.reviewed.toFloat()/localModel.total},modifier=Modifier.fillMaxWidth())
                    }
                    Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                        Text(when(localModel.phase) {
                            LocalModelPhase.VERIFYING -> "Checking model"
                            LocalModelPhase.LOADING -> "Loading model"
                            else -> "Searching…"
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
                    TextButton(onClick={filtersSheet=true},modifier=Modifier.testTag("listingFilters")) {
                        Text("Filters (${(if(wantsPhotos) 1 else 0) + (if(canCurate && !showAll) 1 else 0)})")
                    }
                }
                if (ai?.optBoolean("enabled")==true) Surface(color = Mint, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth().padding(top = 5.dp)) {
                    Row(Modifier.padding(start = 12.dp, end = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                        if(canCurate) Icon(Icons.Filled.AutoAwesome, null, Modifier.size(16.dp), tint = Forest)
                        Spacer(Modifier.width(8.dp))
                        if(canCurate) Text(if (state.error != null) "Search paused" else if (matchCount == 0 && (state.searchDiscovery?.hasMore == true || state.listings.any { it.externalOrder == null && it.relevanceShow == null })) "No matches yet" else "$matchCount ${if (matchCount == 1) "match" else "matches"}",
                            Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, color = Forest)
                        if(!canCurate) Spacer(Modifier.weight(1f))
                        TextButton(onClick={if(showAll && !aiSearch) settings() else model.selectResultView(!showAll)}, modifier=Modifier.testTag("resultView")) {
                            Text(if(showAll) "Show AI selected" else "Show all")
                        }
                    }
                }
                if (canCurate && state.listings.any { it.relevanceUnavailable }) {
                    Text("AI couldn’t review ${state.listings.count { it.relevanceUnavailable }} listings. Choose Show all to search by text.", style=MaterialTheme.typography.bodySmall,color=Muted)
                }
                if (state.error != null) Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                    Text("Couldn’t complete that action.",color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall,modifier=Modifier.weight(1f))
                    TextButton(onClick=settings) { Text("Settings") }
                }
            }
        }
        if (showMap && !state.demo) item(span={GridItemSpan(maxLineSpan)}) {
            MarketMapView(visibleListings,selected,Modifier.fillMaxWidth().height(440.dp).clip(RoundedCornerShape(20.dp))) { cells -> model.command(JSONObject().put("type","set_map_area").put("cells",cells)) }
        }
        if (!showMap && visibleListings.isEmpty()) item(span={GridItemSpan(maxLineSpan)}) {
            EmptyView(if(canCurate && !showAll && state.error != null) "Search paused" else if(searching || canCurate && !showAll && (state.searchDiscovery?.hasMore == true || state.listings.any { it.externalOrder == null && it.relevanceShow == null })) "No matches yet" else if(canCurate && !showAll) "No matching listings" else if(query.isBlank()) "No listings yet" else "No matches",
                if(canCurate && !showAll && state.error != null) "Check your AI settings, then try again." else if(searching) "New matches appear here as they arrive." else if(canCurate && !showAll && (state.searchDiscovery?.hasMore == true || state.listings.any { it.externalOrder == null && it.relevanceShow == null })) "Load more to keep searching, or choose Show all." else if(canCurate && !showAll) "Choose Show all or change your AI settings." else if(query.isBlank()) "Sell something or post what you want to buy." else "Try a different search or clear the filters.",
                Icons.Filled.Storefront)
        }
        if(!showMap) items(visibleListings, key={it.id}) { listing -> ListingCard(listing, state.demo, {selected(listing)}, {model.save(listing.id)}, compact=listLayout) }
        if(!showMap && (state.searchDiscovery?.hasMore == true || canCurate && state.listings.any { it.externalOrder == null && it.relevanceShow == null })) item(span={GridItemSpan(maxLineSpan)}) {
            TextButton(onClick=model::continueSearch,enabled=!searching&&!busy,modifier=Modifier.fillMaxWidth().testTag("loadMoreListings")) { Text("Load more") }
        }
    }
    if(filtersSheet) ModalBottomSheet(onDismissRequest={filtersSheet=false}) {
        var homeEnabled by remember { mutableStateOf(ai?.optBoolean("curate_feed",true) ?: true) }
        var homePrompt by remember { mutableStateOf(ai?.optString("interests") ?: "") }
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal=24.dp).padding(bottom=24.dp).testTag("listingFiltersSheet")) {
            Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                Text("Filters",style=MaterialTheme.typography.headlineSmall,modifier=Modifier.weight(1f))
                TextButton(onClick={model.saveHomeFilter(homeEnabled,homePrompt);filtersSheet=false}) { Text("Done") }
            }
            if(canCurate && !showAll) Text("AI selection is on.", style=MaterialTheme.typography.bodySmall, color=Muted)
            if(state.relatedSearchTerms.isNotEmpty()) {
                Text("Also searched for",style=MaterialTheme.typography.titleSmall)
                Text(state.relatedSearchTerms.joinToString(" · "),modifier=Modifier.padding(bottom=12.dp))
            }
            if (ai?.optString("provider") == CompactSearchFiles.PROVIDER) {
                Text("Compact search reviews submitted searches. Home shows all listings.", style=MaterialTheme.typography.bodySmall, color=Muted)
            } else {
            Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                Text("Home feed",modifier=Modifier.weight(1f))
                Switch(checked=homeEnabled,onCheckedChange={homeEnabled=it},modifier=Modifier.testTag("homeFeedFilter"))
            }
            OutlinedTextField(value=homePrompt,onValueChange={homePrompt=it.take(1000)},label={Text("What would you like to see?")},
                minLines=3,maxLines=6,modifier=Modifier.fillMaxWidth().testTag("homeFeedPrompt"))
            Text("Uses your selected AI when enabled. Search keeps its own query.",style=MaterialTheme.typography.bodySmall,color=Muted,modifier=Modifier.padding(vertical=8.dp))
            }
            Surface(color=MaterialTheme.colorScheme.surfaceContainerLow,shape=RoundedCornerShape(16.dp),modifier=Modifier.padding(vertical=16.dp)) {
                Row(Modifier.fillMaxWidth().padding(horizontal=16.dp,vertical=8.dp),verticalAlignment=Alignment.CenterVertically) {
                    Text("Has photos",style=MaterialTheme.typography.bodyLarge,modifier=Modifier.weight(1f))
                    Switch(checked=wantsPhotos,onCheckedChange=changePhotoFilter,
                        modifier=Modifier.semantics { contentDescription="Has photos" }.testTag("hasPhotosFilter"))
                }
            }
            TextButton(onClick={filtersSheet=false;settings()}) { Text("AI settings") }
            TextButton(onClick={changePhotoFilter(null)},enabled=photoFilter!=null,modifier=Modifier.testTag("resetPhotoFilter")) {
                Text("Reset")
            }
        }
    }
}

@Composable fun ListingCard(listing: Listing, demo: Boolean, open: () -> Unit, save: () -> Unit, compact:Boolean=false) {
    val art: @Composable (Modifier) -> Unit = { modifier ->
        Box(modifier.clip(RoundedCornerShape(20.dp))) {
            ListingArt(listing, demo, Modifier.fillMaxSize())
            IconButton(onClick=save, modifier=Modifier.align(Alignment.TopEnd).padding(7.dp).size(34.dp)
                .background(White.copy(alpha=.92f),CircleShape)) {
                Icon(if(listing.saved) Icons.Filled.Favorite else Icons.Filled.FavoriteBorder,
                    if(listing.saved) "Unsave ${listing.title}" else "Save ${listing.title}", tint=Ink, modifier=Modifier.size(20.dp))
            }
            if(!compact && listing.side == "request") Surface(color=Action, shape=CircleShape,
                modifier=Modifier.align(Alignment.BottomStart).padding(9.dp)) {
                Text("BUYING", color=OnInk, style=MaterialTheme.typography.labelSmall,
                    letterSpacing=1.sp,modifier=Modifier.padding(horizontal=9.dp,vertical=4.dp))
            }
        }
    }
    val labels: @Composable () -> Unit = {
        Text(listing.title, fontWeight=FontWeight.Medium, fontSize=15.sp, lineHeight=20.sp,maxLines=2,overflow=TextOverflow.Ellipsis)
        Spacer(Modifier.height(5.dp))
        Row(verticalAlignment=Alignment.CenterVertically) {
            Text(listing.displayPrice, fontSize=17.sp, fontWeight=FontWeight.Bold)
            if(listing.side == "request" && !listing.isBitcoinOffer) Text(" budget", fontSize=11.sp,color=Muted)
        }
        listing.externalOrder?.let { Text(it.methods,color=Muted,style=MaterialTheme.typography.bodySmall,maxLines=1,overflow=TextOverflow.Ellipsis) }
        listing.escrow?.bitcoinTerms?.let { Text(it,color=Muted,style=MaterialTheme.typography.bodySmall) }
        if(listing.location.isNotBlank()) Row(verticalAlignment=Alignment.CenterVertically,modifier=Modifier.padding(top=5.dp)) {
            Icon(Icons.Filled.LocationOn,null,Modifier.size(12.dp),tint=Muted); Spacer(Modifier.width(3.dp))
            Text(listing.location,color=Muted,fontSize=12.sp,maxLines=1,overflow=TextOverflow.Ellipsis)
        }
        listing.relevance?.takeIf { it.isNotBlank() }?.let {
            Text(it,color=Forest,fontSize=11.sp,maxLines=2,modifier=Modifier.padding(top=5.dp))
        }
    }
    val clickable=Modifier.fillMaxWidth().clickable(onClick=open)
    if(compact) Row(clickable,verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
        art(Modifier.size(86.dp)); Column(Modifier.weight(1f)) { labels() }
    } else Column(clickable) { art(Modifier.fillMaxWidth().aspectRatio(1f)); Spacer(Modifier.height(10.dp)); labels() }

}

@Composable fun SavedView(state: MarketSnapshot, model: MarketModel, selected: (Listing)->Unit) {
    var listLayout by rememberListLayout()
    val saved = state.savedListings ?: state.listings.filter { it.saved }
    LazyVerticalGrid(columns=GridCells.Fixed(if(listLayout) 1 else 2),horizontalArrangement=Arrangement.spacedBy(14.dp),verticalArrangement=Arrangement.spacedBy(20.dp),
        contentPadding=PaddingValues(start=22.dp,end=22.dp,bottom=90.dp)) {
        item(span={GridItemSpan(maxLineSpan)}) {
            Column(Modifier.padding(top=16.dp,bottom=10.dp)) {
                Row(verticalAlignment=Alignment.CenterVertically) {
                    Text("Saved listings",style=MaterialTheme.typography.headlineMedium,modifier=Modifier.weight(1f))
                    TextButton(onClick={listLayout=!listLayout}) { Text(if(listLayout) "Grid" else "List") }
                }
            }
        }
        if(saved.isEmpty()) item(span={GridItemSpan(maxLineSpan)}) {
            EmptyView("No saved listings","Tap the heart on a listing to keep it here.",Icons.Filled.Favorite)
        }
        items(saved,key={it.id}) { item -> ListingCard(item,state.demo,{selected(item)},{model.save(item.id)},compact=listLayout) }
    }
}

@Composable fun ListingDetail(listing: Listing, demo: Boolean, model: MarketModel, busy: Boolean, person: PublicPerson?, openProfile:(String)->Unit, buy:()->Unit, inbox:()->Unit) {
    val clipboard=LocalClipboardManager.current
    var showEscrow by remember(listing.id) { mutableStateOf(false) }
    if(showEscrow) EscrowDialog(model,listing.id,null){showEscrow=false}
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal=24.dp).padding(bottom=30.dp)) {
        if(listing.externalOrder==null) ListingArt(listing,demo,Modifier.fillMaxWidth().height(245.dp).clip(RoundedCornerShape(24.dp)))
        Spacer(Modifier.height(22.dp))
        Text(if(listing.isBitcoinOffer) (if(listing.side=="request") "BUYING BITCOIN" else "SELLING BITCOIN") else listing.category.uppercase(),color=Forest,style=MaterialTheme.typography.labelSmall,letterSpacing=1.5.sp)
        Spacer(Modifier.height(8.dp));Text(listing.title,style=MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(9.dp));Text(listing.displayPrice,fontSize=29.sp,fontWeight=FontWeight.SemiBold)
        listing.escrow?.bitcoinTerms?.let { Text(it,color=Muted,style=MaterialTheme.typography.bodySmall) }
        if(listing.location.isNotBlank()) Row(Modifier.padding(top=12.dp),verticalAlignment=Alignment.CenterVertically) {
            Icon(Icons.Filled.LocationOn,null,Modifier.size(17.dp),tint=Muted);Spacer(Modifier.width(5.dp));Text(listing.location,color=Muted)
        }
        var expiryNow by remember(listing.id) { mutableStateOf(System.currentTimeMillis()/1000) }
        LaunchedEffect(listing.id) { while(true) { expiryNow=System.currentTimeMillis()/1000; kotlinx.coroutines.delay(60_000) } }
        Text(NativeListingExpiry.detail(listing.expiresAt,expiryNow),color=Muted,style=MaterialTheme.typography.bodySmall,modifier=Modifier.testTag("listingExpiryDetail"))
        if(listing.externalOrder!=null) Text(listing.externalOrder.platform, color=Muted)
        else TextButton(onClick={openProfile(listing.author)},modifier=Modifier.fillMaxWidth().padding(top=12.dp).semantics { contentDescription = "View author" }) {
            UserRow(person ?: PublicPerson.unnamed(listing.author))
        }
        Spacer(Modifier.height(22.dp));HorizontalDivider(color=Line);Spacer(Modifier.height(21.dp))
        if(listing.externalOrder!=null) Text(listing.description)
        else { ListingDescription(listing.description); ReviewsView(listing.reviewAddress,model,product=true) }
        Spacer(Modifier.height(24.dp))
        if(demo) Text("Sample listing · Preview stays on this device.",color=Muted,style=MaterialTheme.typography.bodySmall)
        else if(listing.mine) Text(if(listing.delivery == "queued") "Your listing · Waiting to send" else if(listing.delivery == "failed") "Your listing · Not sent" else "Your listing",color=Muted,style=MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement=Arrangement.spacedBy(10.dp)) {
            OutlinedButton(onClick={model.save(listing.id)},modifier=Modifier.weight(1f).height(51.dp),shape=RoundedCornerShape(15.dp)) {
                Icon(if(listing.saved) Icons.Filled.Favorite else Icons.Filled.FavoriteBorder,null,Modifier.size(18.dp));Spacer(Modifier.width(6.dp))
                Text(if(listing.saved) "Saved" else "Save")
            }
            if(listing.externalOrder!=null) OutlinedButton(onClick={clipboard.setText(AnnotatedString(listing.externalOrder.link))},modifier=Modifier.weight(1f).height(51.dp)) { Text("Copy link") }
            else Button(enabled=!busy&&!demo&&!listing.mine,onClick={
                if(listing.side=="offer" && !listing.isBitcoinOffer) buy() else model.command(JSONObject().put("type","contact").put("author",listing.author).put("listing_id",listing.id),inbox)
            },modifier=Modifier.weight(1.35f).height(51.dp),shape=RoundedCornerShape(15.dp)) {
                Text(if(listing.isBitcoinOffer) (if(listing.side=="offer") "Message seller" else "Message buyer") else if(listing.side=="offer") NativeTransportType.classify(listing.tags)?.requestLabel ?: "Buy" else "Respond")
            }
        }
        if(!listing.mine && !demo && listing.side=="offer" && !listing.isBitcoinOffer) TextButton(enabled=!busy,onClick={
            model.command(JSONObject().put("type","contact").put("author",listing.author).put("listing_id",listing.id),inbox)
        },modifier=Modifier.fillMaxWidth()) { Text("Message") }
        if (!demo && !listing.mine && listing.externalOrder == null && listing.side == "offer")
            key(listing.id, model.state.value.publicKey) { MerchantNoticeButton(listing.id, model) }
        if(!listing.mine && !demo && listing.escrow!=null && (listing.isBitcoinOffer || listing.side=="request") && JSONObject(model.state.value.settings).optBoolean("escrow_ui"))
            OutlinedButton(onClick={showEscrow=true},modifier=Modifier.fillMaxWidth()){Text("Arrange escrow")}
        if(listing.mine && !demo && listing.externalOrder==null) TextButton(enabled=!busy,onClick={model.command(JSONObject().put("type","close").put("id",listing.id))}) { Text("Close listing") }
    }
}

@Composable
private fun MerchantNoticeButton(listingId: String, model: MarketModel) {
    var status by remember { mutableStateOf("") }
    var requested by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf(false) }
    LaunchedEffect(requested) {
        try {
            status = model.merchantNotice(listingId, requested)
            while (status == "queued") {
                delay(2000)
                status = model.merchantNotice(listingId, false)
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            if (requested) { requested = false; problem = true }
        }
    }
    when (status) {
        "available", "no-inbox" -> {
            OutlinedButton(onClick = { problem = false; requested = true }, enabled = !requested && status == "available",
                modifier = Modifier.fillMaxWidth().testTag("merchantNotice")) { Text("Notify seller anonymously") }
            Text(if (status == "no-inbox") "This seller hasn’t published an inbox for anonymous notices." else "Sends “Someone wants to buy from you on market.iris.to. Open Iris Market to set up private messaging.”",
                color = Muted, style = MaterialTheme.typography.bodySmall)
        }
        "queued" -> Text("Anonymous notice queued.", color = Muted)
        "sent" -> Text("Notice accepted by the seller’s inbox relay.", color = Muted)
    }
    if (problem) Text("Could not save the notice. Try again.", color = MaterialTheme.colorScheme.error)
}
