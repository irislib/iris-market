package to.iris.market

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
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
    override fun onResume() { super.onResume(); marketModel.setActive(true) }
    override fun onPause() { marketModel.setActive(false); super.onPause() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MarketAppView(model: MarketModel, appearance: Appearance, changeAppearance: (Appearance) -> Unit, switchMode: (Boolean) -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    val busy by model.busy.collectAsStateWithLifecycle()
    val notice by model.notice.collectAsStateWithLifecycle()
    var tab by remember { mutableIntStateOf(0) }
    var selected by remember { mutableStateOf<Listing?>(null) }
    var posting by remember { mutableStateOf(false) }
    var settings by remember { mutableStateOf(false) }
    Scaffold(
        containerColor = Cream,
        bottomBar = {
            NavigationBar(containerColor = Cream, tonalElevation = 0.dp, modifier = Modifier.background(Cream)) {
                listOf("Browse" to Icons.Filled.Storefront, "Saved" to Icons.Filled.Bookmark,
                    "Inbox" to Icons.Filled.ChatBubble, "You" to Icons.Filled.Person).forEachIndexed { index, (label, icon) ->
                    NavigationBarItem(selected = tab == index, onClick = {
                        tab = index
                        if (index == 1) model.filter("", "all")
                    }, icon = { Icon(icon, label, Modifier.size(23.dp)) }, label = { Text(label) },
                        colors = NavigationBarItemDefaults.colors(selectedIconColor = Ink, selectedTextColor = Ink,
                            indicatorColor = Mint, unselectedIconColor = Muted, unselectedTextColor = Muted))
                }
            }
        }, floatingActionButton = {
            if (tab == 0 || tab == 1) FloatingActionButton(onClick = { posting = true }, containerColor = Ink,
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
                } else Surface(color = Mint, shape = CircleShape) {
                    Row(Modifier.padding(horizontal = 10.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(6.dp).background(Forest, CircleShape)); Spacer(Modifier.width(5.dp))
                        Text("Open network", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
            when (tab) {
                0 -> BrowseView(state, model, busy, selected = { selected = it }, settings = { settings = true })
                1 -> SavedView(state, model, selected = { selected = it })
                2 -> InboxView(state, model, busy)
                3 -> ProfileView(state, busy, { settings = true }, { switchMode(!state.demo) }, model, appearance, changeAppearance)
            }
        }
    }
    selected?.let { original ->
        val listing = state.listings.firstOrNull { it.id == original.id } ?: original
        ModalBottomSheet(onDismissRequest = { selected = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Cream) {
            ListingDetail(listing, state.demo, model, busy) { selected = null; tab = 2 }
        }
    }
    if (posting) ModalBottomSheet(onDismissRequest = { posting = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Cream) {
        PostListing(state, model, busy) { posting = false }
    }
    if (settings) ModalBottomSheet(onDismissRequest = { settings = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Cream) {
        SettingsView(state, model, busy) { settings = false }
    }
    notice?.let { text -> AlertDialog(onDismissRequest = model::dismissNotice,
        title = { Text("Couldn’t finish that") }, text = { Text(text) },
        confirmButton = { TextButton(onClick = model::dismissNotice) { Text("OK") } }) }
}
