package to.iris.market

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.core.view.WindowCompat
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle

class MainActivity : ComponentActivity() {
    private val marketModel: MarketModel by lazy {
        ViewModelProvider(this, object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                MarketModel(application, intent.getBooleanExtra("demo", false)) as T
        })[MarketModel::class.java]
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge()
        marketModel.handlePushIntent(intent)
        setContent {
            val preferences = remember { getSharedPreferences("market-appearance", MODE_PRIVATE) }
            var appearance by remember { mutableStateOf(Appearance.entries.firstOrNull {
                it.name == preferences.getString("mode", Appearance.System.name)
            } ?: Appearance.System) }
            val dark = when (appearance) {
                Appearance.System -> isSystemInDarkTheme()
                Appearance.Light -> false
                Appearance.Dark -> true
            }
            SideEffect {
                WindowCompat.getInsetsController(window, window.decorView).apply {
                    isAppearanceLightStatusBars = !dark
                    isAppearanceLightNavigationBars = !dark
                }
            }
            MarketTheme(dark) {
                MarketAppView(marketModel, appearance, { value ->
                    appearance = value
                    preferences.edit().putString("mode", value.name).apply()
                }) { preview ->
                    startActivity(Intent(this, MainActivity::class.java).putExtra("demo", preview)); finish()
                }
            }
        }
    }
    override fun onNewIntent(intent:Intent){super.onNewIntent(intent);setIntent(intent);marketModel.handlePushIntent(intent)}
    override fun onResume() { super.onResume(); marketModel.setActive(true) }
    override fun onPause() { marketModel.setActive(false); super.onPause() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MarketAppView(model: MarketModel, appearance: Appearance, changeAppearance: (Appearance) -> Unit, switchMode: (Boolean) -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val busy by model.busy.collectAsStateWithLifecycle()
    val notice by model.notice.collectAsStateWithLifecycle()
    val profileSetupRequested by model.profileSetupRequested.collectAsStateWithLifecycle()
    var tab by remember { mutableIntStateOf(0) }
    var selected by remember { mutableStateOf<Listing?>(null) }
    var reviewListing by remember { mutableStateOf<Listing?>(null) }
    var orderId by remember { mutableStateOf<String?>(null) }
    var profileAuthor by remember { mutableStateOf<String?>(null) }
    var posting by remember { mutableStateOf(false) }
    var transport by remember { mutableStateOf(false) }
    var menuExpanded by remember { mutableStateOf(false) }
    var serviceType by remember { mutableStateOf<NativeTransportType?>(null) }
    var serviceArea by remember { mutableStateOf("") }
    var serviceAreas by remember { mutableStateOf<String?>(null) }
    var settings by remember { mutableStateOf(false) }
    var photoFilter by remember { mutableStateOf<Boolean?>(null) }
    val pushRoute by model.pushRoute.collectAsStateWithLifecycle()
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    var resumed by remember(lifecycle){mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))}
    DisposableEffect(lifecycle){val observer=LifecycleEventObserver {_,_->resumed=lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)};lifecycle.addObserver(observer);onDispose {lifecycle.removeObserver(observer)}}
    LaunchedEffect(pushRoute,resumed,state.publicKey,state.revision){
        val route=pushRoute
        if(resumed&&!state.demo&&!state.profileNameRequired&&route!=null){
            selected=null;reviewListing=null;profileAuthor=null;posting=false;transport=false;settings=false
            if(route.orderID!=null){tab=3;if(state.orders.any {it.id==route.orderID}){orderId=route.orderID;model.consumePushRoute()}}
            else {orderId=null;tab=2}
        }
    }
    val hasProfile = !state.demo && !state.profileNameRequired && state.publicKey.isNotBlank()
    val ownPerson = state.people[state.publicKey] ?: PublicPerson.unnamed(state.publicKey).copy(name=NativeProfileNames.name(state.publicKey))
    Scaffold(
        containerColor = Cream,
        bottomBar = {
            NavigationBar(containerColor = Cream, tonalElevation = 0.dp, modifier = Modifier.background(Cream)) {
                listOf("Browse" to Icons.Filled.Storefront, "Saved" to Icons.Filled.Favorite,
                    "Inbox" to Icons.Filled.ChatBubble, "Orders" to Icons.Filled.ReceiptLong).forEachIndexed { index, (label, icon) ->
                    NavigationBarItem(selected = tab == index, onClick = {
                        if (tab != index) {
                            model.consumePushRoute()
                            tab = index
                            if (index == 1) model.filter("", "all")
                            else if (index == 0) model.filter("", "offer")
                        }
                    }, icon = { Icon(icon, label, Modifier.size(23.dp)) }, label = { Text(label) },
                        colors = NavigationBarItemDefaults.colors(selectedIconColor = Ink, selectedTextColor = Ink,
                            indicatorColor = Mint, unselectedIconColor = Muted, unselectedTextColor = Muted))
                }
            }
        }, floatingActionButton = {
            if (tab == 0 || tab == 1) FloatingActionButton(onClick = { serviceType = null; serviceArea = ""; serviceAreas = null; if (state.profileNameRequired && !state.demo) model.requestProfileSetup() else posting = true }, containerColor = Action,
                contentColor = OnInk, shape = CircleShape) { Icon(Icons.Filled.Add, "Create listing") }
        }
    ) { inset ->
        Column(Modifier.fillMaxSize().padding(inset)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                IrisMark(Modifier.size(27.dp)); Spacer(Modifier.width(9.dp))
                Text("iris market", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                if (state.demo) Surface(color = Sand, shape = CircleShape) {
                    Text("Preview", Modifier.padding(horizontal = 11.dp, vertical = 5.dp), style = MaterialTheme.typography.labelMedium)
                }
                Box {
                    IconButton(onClick = { menuExpanded = true }, modifier = Modifier.semantics { contentDescription = "Menu" }) {
                        if (hasProfile) UserAvatar(ownPerson, 34.dp) else Icon(Icons.Filled.MoreHoriz, null, tint = Muted)
                    }
                    DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                        if (hasProfile) DropdownMenuItem(text = { Column { Text(ownPerson.displayName, maxLines=1); Text("View profile", style=MaterialTheme.typography.bodySmall, color=Muted) } }, leadingIcon = { UserAvatar(ownPerson, 32.dp) }, onClick = { menuExpanded = false; tab = 4 })
                        else if (!state.demo) DropdownMenuItem(text = { Text("Sign in") }, leadingIcon = { Icon(Icons.Filled.Person, null) }, onClick = { menuExpanded = false; model.requestProfileSetup() }, enabled=state.publicKey.isNotBlank())
                        HorizontalDivider()
                        DropdownMenuItem(text = { Text("Transport") }, leadingIcon = { Icon(Icons.Filled.DirectionsCar, null) }, onClick = { menuExpanded = false; transport = true })
                        DropdownMenuItem(text = { Text("Settings") }, leadingIcon = { Icon(Icons.Filled.Settings, null) }, onClick = { menuExpanded = false; tab = 5 })
                        DropdownMenuItem(text = { Text("AI settings") }, leadingIcon = { Icon(Icons.Filled.AutoAwesome, null) }, onClick = { menuExpanded = false; settings = true })
                        HorizontalDivider()
                        Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf(Appearance.Light to Icons.Filled.LightMode, Appearance.Dark to Icons.Filled.DarkMode, Appearance.System to Icons.Filled.BrightnessAuto).forEach { (mode, icon) ->
                                FilledIconToggleButton(checked = appearance == mode, onCheckedChange = { changeAppearance(mode) }) {
                                    Icon(icon, mode.name, Modifier.size(20.dp))
                                }
                            }
                        }
                    }
                }
            }
            when (tab) {
                0 -> BrowseView(state, model, busy, selected = { selected = it }, settings = { settings = true }, photoFilter=photoFilter, changePhotoFilter={photoFilter=it})
                1 -> SavedView(state, model, selected = { selected = it })
                2 -> InboxView(state, model, busy, openOrder = { orderId = it }, visible = orderId==null&&selected==null&&profileAuthor==null&&!posting&&!transport&&!settings&&!profileSetupRequested)
                3 -> OrdersView(state, openOrder = { orderId = it })
                4 -> PublicProfileView(state.publicKey, state, model, openListing={selected=it}, message={author -> model.command(org.json.JSONObject().put("type","contact").put("author",author)) {tab=2} }) {tab=0}
                5 -> ProfileView(state, busy, { settings = true }, { switchMode(!state.demo) }, model, appearance, changeAppearance, openProfile={profileAuthor=state.publicKey},openTransport={transport=true})
            }
        }
    }
    selected?.let { original ->
        val listing = state.listings.firstOrNull { it.id == original.id } ?: original
        ModalBottomSheet(onDismissRequest = { selected = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Cream) {
            ListingDetail(listing, state.demo, model, busy, person=state.people[listing.author], openProfile={ profileAuthor=it; selected=null }, buy={ reviewListing=listing; selected=null }) { selected = null; tab = 2 }
        }
    }
    profileAuthor?.let { author ->
        ModalBottomSheet(onDismissRequest={profileAuthor=null},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true),containerColor=Cream) {
            PublicProfileView(author,state,model,openListing={profileAuthor=null;selected=it}, message={ target -> model.command(org.json.JSONObject().put("type","contact").put("author",target)) { profileAuthor=null; tab=2 } }) { profileAuthor=null }
        }
    }
    reviewListing?.let { listing ->
        ModalBottomSheet(onDismissRequest = { reviewListing = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Cream) {
            OrderReview(listing, state, model, busy) { id -> reviewListing = null; if (id != null) { orderId = id; tab = 3 } }
        }
    }
    orderId?.let { id ->
        ModalBottomSheet(onDismissRequest = { orderId = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Cream) {
            val order = state.orders.firstOrNull { it.id == id }
            if (order != null) OrderDetail(order, state, model, busy, openProfile = { profileAuthor = it; orderId = null }) { orderId = null }
            else Column(Modifier.padding(24.dp)) { Text("This order is not available on this device yet."); TextButton(onClick = { orderId = null }) { Text("Done") } }
        }
    }
    if (posting) ModalBottomSheet(onDismissRequest = { posting = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Cream) {
        PostListing(state, model, busy, transportType = serviceType, initialArea = serviceArea, initialServiceAreas = serviceAreas) { posting = false }
    }
    if (transport) ModalBottomSheet(onDismissRequest = { transport = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Cream) {
        CourierWorkspaceView(state, model, openListing = { selected = it; transport = false }, openOrder = { orderId = it; transport = false }, announce = { type, area, areas -> serviceType = type; serviceArea = area; serviceAreas = areas; transport = false; posting = true }) { transport = false }
    }
    if (settings) ModalBottomSheet(onDismissRequest = { settings = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Cream) {
        SettingsView(state, model, busy) { settings = false }
    }
    if (profileSetupRequested) ModalBottomSheet(onDismissRequest = model::dismissProfileSetup, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Cream) {
        ProfileSetupView(model, busy, model::dismissProfileSetup)
    }
    notice?.let { text -> AlertDialog(onDismissRequest = model::dismissNotice,
        title = { Text("Couldn’t finish that") }, text = { Text(text) },
        confirmButton = { TextButton(onClick = model::dismissNotice) { Text("OK") } }) }
}

@Composable
fun ProfileSetupView(model: MarketModel, busy: Boolean, close: () -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    var name by remember(state.publicKey) { mutableStateOf("") }
    var existingProfile by remember { mutableStateOf(false) }
    LaunchedEffect(state.profileNameRequired) { if (!state.profileNameRequired && state.publicKey.isNotBlank()) close() }
    if (existingProfile) {
        AccountSignInView(model, busy) { existingProfile = false }
    } else {
        Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(28.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment=Alignment.CenterVertically) {
                Text("Sign in", style=MaterialTheme.typography.titleLarge, modifier=Modifier.weight(1f))
                TextButton(onClick=close) { Text("Cancel") }
            }
            IrisMark(Modifier.size(48.dp))
            Text("What should we call you?", style=MaterialTheme.typography.headlineMedium)
            MarketField(name, {name=it}, "Your name (optional)", hint=NativeProfileNames.name(state.publicKey))
            Button(enabled=!busy && state.publicKey.isNotBlank(), modifier=Modifier.fillMaxWidth(), onClick={
                model.command(org.json.JSONObject().put("type","update_profile").put("name",name.trim())) { close() }
            }) { Text("Continue") }
            TextButton(onClick={existingProfile=true}, modifier=Modifier.fillMaxWidth()) { Text("Existing profile") }
        }
    }
}
