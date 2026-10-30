package to.iris.market

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import org.json.JSONObject

private data class InboxThread(val conversation:Conversation,val key:String,val context:MessageContext?,val messages:List<Message>) {
    val id:String get()=conversation.id+"|"+key
    val latestActivity:Long get()=messages.maxOfOrNull {it.createdAt} ?: 0L
}

/** A view-scoped read lease. Lifecycle loss stops new batches and notification suppression. */
internal class VisibleThreadReads(
    private val peer:String,private val key:String,
    private val accountAllowed:()->Boolean,
    private val setActiveContext:(String?,String?)->Unit,
    private val markRead:(List<String>,(Boolean)->Unit)->Unit
) {
    private var visible=false
    private var closed=false
    private var inflight=false
    private var incoming:List<String> = emptyList()
    private val marked=mutableSetOf<String>()
    fun update(active:Boolean,ids:List<String>) {
        val allowed=active&&!closed&&accountAllowed()
        if(visible&&!allowed)setActiveContext(null,null)
        visible=allowed;incoming=ids
        if(allowed){setActiveContext(peer,key);markNext()}
    }
    private fun markNext() {
        if(!visible||closed||inflight||!accountAllowed())return
        val batch=incoming.filterNot {it in marked}.take(256)
        if(batch.isEmpty())return
        marked.addAll(batch);inflight=true
        markRead(batch){success->
            inflight=false
            if(accountAllowed()){if(success)markNext() else marked.removeAll(batch.toSet())}
        }
    }
    fun close(){update(false,emptyList());closed=true}
}

/** Available snapshot data only: no profile, listing or relay request on inbox open. */
private fun inboxContextTitle(context:MessageContext?,state:MarketSnapshot):String {
    context?.orderId?.let {id->
        val title=state.orders.firstOrNull {it.id==id}?.items?.map {it.title.trim()}?.filter {it.isNotEmpty()}?.joinToString(", ").orEmpty()
        return if(title.isEmpty()) "Order" else "Order · $title"
    }
    val address=context?.listing ?: return "Conversation"
    val coordinate=address.removePrefix("30402:")
    val title=(state.listings+(state.savedListings ?: emptyList())+(state.profileListings?.listings ?: emptyList())).firstOrNull {it.id==coordinate}?.title?.trim().orEmpty()
    return title.ifEmpty {"Listing inquiry"}
}

@Composable fun InboxView(state:MarketSnapshot,model:MarketModel,busy:Boolean,openOrder:(String)->Unit,visible:Boolean=true) {
    var selected by remember(state.publicKey) { mutableStateOf<String?>(null) }
    var selectedThread by remember(state.publicKey) { mutableStateOf("*") }
    var selectedContext by remember(state.publicKey) { mutableStateOf<MessageContext?>(null) }
    val preferences=androidx.compose.ui.platform.LocalContext.current.getSharedPreferences("market-display",android.content.Context.MODE_PRIVATE)
    var groupByThreads by remember { mutableStateOf(preferences.getBoolean("message-threads",true)) }
    val threads=state.conversations.flatMap { c ->
        if(!groupByThreads)listOf(InboxThread(c,"*",null,c.messages))
        else if(c.messages.isEmpty())listOf(InboxThread(c,"general",null,emptyList()))
        else c.messages.groupBy { it.threadKey }.map { (key,messages) -> InboxThread(c,key,messages.first().context?:messages.first().orderId?.let(MessageContext::order),messages) }
    }.sortedWith(compareByDescending<InboxThread> {it.latestActivity}.thenBy {it.id})
    var pasted by remember { mutableStateOf("") };var showConnect by remember { mutableStateOf(false) }
    val clipboard=LocalClipboardManager.current
    val route by model.pushRoute.collectAsStateWithLifecycle()
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    var resumed by remember(lifecycle){mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))}
    DisposableEffect(lifecycle){val observer=LifecycleEventObserver {_,_->resumed=lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)};lifecycle.addObserver(observer);onDispose {lifecycle.removeObserver(observer)}}
    LaunchedEffect(route,state.revision,visible,resumed){
        val pending=route
        if(visible&&resumed&&pending!=null&&pending.orderID==null&&state.conversations.any {it.id==pending.peerID}){
            val key=pending.threadID?.let {"thread:$it"} ?: "general"
            selected=pending.peerID;selectedThread=key
            selectedContext=state.conversations.first {it.id==pending.peerID}.messages.firstOrNull {it.threadKey==key}?.context ?: pending.threadID?.let {MessageContext(it)}
            model.consumePushRoute()
        }
    }
    val conversation=state.conversations.firstOrNull{it.id==selected}
    if(conversation != null) {
        ConversationView(if(selectedThread=="*")conversation else conversation.copy(messages=conversation.messages.filter { it.threadKey==selectedThread }),state.people[conversation.id] ?: PublicPerson.unnamed(conversation.id),model,busy,openOrder,selectedContext,state.publicKey,selectedThread,visible,inboxContextTitle(selectedContext,state)){selected=null};return
    }
    Column(Modifier.fillMaxSize().padding(horizontal=22.dp)) {
        Row(Modifier.padding(top=15.dp,bottom=8.dp).fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
            Text("Inbox",style=MaterialTheme.typography.headlineMedium)
        }
        Row(horizontalArrangement=Arrangement.spacedBy(8.dp),modifier=Modifier.padding(top=8.dp)) {
            listOf(true to "Threads",false to "People").forEach { (threads,label) -> FilterChip(selected=groupByThreads==threads,onClick={groupByThreads=threads;preferences.edit().putBoolean("message-threads",threads).apply()},label={Text(label)}) }
        }
        Row(horizontalArrangement=Arrangement.spacedBy(8.dp),modifier=Modifier.padding(vertical=12.dp)) {
            OutlinedButton(onClick={showConnect=!showConnect},shape=CircleShape) { Icon(Icons.Filled.Link,null,Modifier.size(18.dp));Spacer(Modifier.width(6.dp));Text("Connect") }
            if(!state.demo) TextButton(enabled=!busy,onClick={model.action("create_invite");showConnect=true}) { Text("Create invitation") }
        }
        if(showConnect) Column(verticalArrangement=Arrangement.spacedBy(9.dp)) {
            MarketField(pasted,{pasted=it},"Paste a private invitation")
            Button(enabled=!state.demo && pasted.isNotBlank() && !busy,onClick={
                model.command(JSONObject().put("type","accept_invite").put("invite",pasted.trim())){pasted="";showConnect=false}
            }) { Text("Accept invitation") }
            state.invite?.let { invite ->
                Surface(color=Mint,shape=RoundedCornerShape(16.dp)) { Column(Modifier.padding(14.dp)) {
                    Text("Your invitation is ready",fontWeight=FontWeight.SemiBold)
                    Text("Share it with the person you want to connect with.",color=Muted,style=MaterialTheme.typography.bodySmall)
                    TextButton(onClick={clipboard.setText(AnnotatedString(invite))}) { Icon(Icons.Filled.ContentCopy,null,Modifier.size(16.dp));Spacer(Modifier.width(6.dp));Text("Copy invitation") }
                } }
            }
            Spacer(Modifier.height(6.dp))
        }
        if(state.conversations.isEmpty()) EmptyView("No conversations","Open a listing to send a private enquiry, or connect with an invitation.",Icons.Filled.Forum)
        else LazyColumn(verticalArrangement=Arrangement.spacedBy(10.dp),contentPadding=PaddingValues(bottom=30.dp)) {
            items(threads,key={it.id}) { thread ->
                val c=thread.conversation
                Surface(color=White,shape=RoundedCornerShape(20.dp),modifier=Modifier.fillMaxWidth().clickable{selected=c.id;selectedThread=thread.key;selectedContext=thread.context}) {
                    Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
                        UserRow(state.people[c.id] ?: PublicPerson.unnamed(c.id),thread.messages.lastOrNull()?.text ?: "No messages",47.dp)
                        if(groupByThreads)Text(inboxContextTitle(thread.context,state),color=Muted,style=MaterialTheme.typography.bodySmall,maxLines=1,overflow=TextOverflow.Ellipsis,modifier=Modifier.padding(start=59.dp))
                    }
                }
            }
        }
    }
}

@Composable fun ConversationView(c:Conversation,person:PublicPerson,model:MarketModel,busy:Boolean,openOrder:(String)->Unit,context:MessageContext?=null,accountID:String="",threadKey:String="*",visible:Boolean=true,contextTitle:String="Conversation",back:()->Unit) {
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    val reads=remember(model,accountID,c.id,threadKey){VisibleThreadReads(c.id,threadKey,
        accountAllowed={accountID.isNotBlank()&&model.state.value.publicKey==accountID&&!model.state.value.demo},
        setActiveContext={peer,key->if(model.state.value.publicKey==accountID)model.setActivePushContext(peer,key)},
        markRead={ids,complete->model.markMessagesRead(ids,complete)})}
    val incoming=c.messages.filterNot {it.mine}.map {it.id}
    val currentIncoming by rememberUpdatedState(incoming)
    val currentlyVisible by rememberUpdatedState(visible)
    DisposableEffect(lifecycle,reads){
        val observer=LifecycleEventObserver {_,_->reads.update(currentlyVisible&&lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED),currentIncoming)}
        lifecycle.addObserver(observer)
        onDispose {lifecycle.removeObserver(observer);reads.close()}
    }
    LaunchedEffect(visible,incoming,reads){reads.update(visible&&lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED),incoming)}
    val drafts by model.messageDrafts.collectAsState()
    val draftKey=NativeMessageDrafts.key(accountID.ifBlank {model.state.value.publicKey},c.id,context?.key ?: "general")
    val message=drafts[draftKey].orEmpty()
    Column(Modifier.fillMaxSize().padding(horizontal=18.dp).imePadding()) {
        Row(verticalAlignment=Alignment.CenterVertically) {
            IconButton(onClick=back){Icon(Icons.Filled.ArrowBack,"Back to inbox")}
            Box(Modifier.weight(1f)) { UserRow(person,"Private conversation",32.dp) }
        }
        context?.orderId?.let { id -> TextButton(onClick={openOrder(id)}) { Text(contextTitle) } }
        if(context?.listing!=null)Text(contextTitle,color=Muted,style=MaterialTheme.typography.bodySmall,modifier=Modifier.padding(vertical=8.dp))
        LazyColumn(Modifier.weight(1f).fillMaxWidth(),contentPadding=PaddingValues(vertical=18.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
            items(c.messages,key={it.id}) { m ->
                Row(Modifier.fillMaxWidth(),horizontalArrangement=if(m.mine) Arrangement.End else Arrangement.Start) {
                    Surface(color=if(m.mine) Action else White,contentColor=if(m.mine) OnInk else Ink,
                        shape=RoundedCornerShape(19.dp),modifier=Modifier.widthIn(max=290.dp)) {
                        Column(Modifier.padding(horizontal=15.dp,vertical=12.dp)) {
                            if(m.cashu != null) PaymentMessage(m.cashu,m.mine) else Text(m.text,style=MaterialTheme.typography.bodyLarge)
                            m.orderId?.let { id -> TextButton(onClick={openOrder(id)},colors=ButtonDefaults.textButtonColors(contentColor=if(m.mine) OnInk else Ink)) { Text("View order") } }
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(bottom=12.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(7.dp)) {
            OutlinedTextField(value=message,onValueChange={model.setMessageDraft(draftKey,it)},placeholder={Text("Write a message")},modifier=Modifier.weight(1f),
                shape=RoundedCornerShape(23.dp),maxLines=4,colors=OutlinedTextFieldDefaults.colors(unfocusedBorderColor=Line))
            FilledIconButton(enabled=message.isNotBlank()&&!busy&&draftKey.account==model.state.value.publicKey,onClick=send@{
                if(draftKey.account!=model.state.value.publicKey)return@send
                val pending=model.messageDrafts.value[draftKey].orEmpty()
                model.command(JSONObject().put("type","send_message").put("peer_id",c.id).put("text",pending.trim()).apply { context?.let { put("context",it.json()) } }){model.finishMessageDraft(draftKey,pending,true)}
            }) { Icon(Icons.Filled.ArrowUpward,"Send message") }
        }
    }
}

@Composable fun ProfileView(state:MarketSnapshot,busy:Boolean,settings:()->Unit,switchMode:()->Unit,model:MarketModel,appearance:Appearance,changeAppearance:(Appearance)->Unit,openProfile:()->Unit,openTransport:()->Unit = {}) {
    var signIn by remember {mutableStateOf(false)}
    if(signIn) { if(state.profileNameRequired) ProfileSetupView(model,busy){signIn=false} else AccountSignInView(model,busy){signIn=false};return }
    val ai=remember(state.settings){JSONObject(state.settings).optJSONObject("ai")?:JSONObject()}
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal=24.dp).padding(bottom=35.dp),verticalArrangement=Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(7.dp))
        Text("Settings",style=MaterialTheme.typography.headlineMedium)
        Row(verticalAlignment=Alignment.CenterVertically,modifier=Modifier.padding(vertical=10.dp)) {
            UserAvatar(state.people[state.publicKey] ?: PublicPerson.unnamed(state.publicKey),70.dp)
            Spacer(Modifier.width(17.dp));Column { Text(if(state.demo) "Preview profile" else "Your profile",style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.SemiBold)
                if(state.demo) Text("Sample listings",color=Muted,style=MaterialTheme.typography.bodySmall) }
        }
        OutlinedButton(onClick={signIn=true},enabled=!state.demo) {Icon(Icons.Filled.Login,null);Spacer(Modifier.width(8.dp));Text("Sign in")}
        if(!state.demo&&!state.canSign) Text("Sign in with your profile key to publish listings.",color=Muted,style=MaterialTheme.typography.bodySmall)
        TextButton(onClick=openTransport) { Icon(Icons.Filled.DirectionsCar,null);Spacer(Modifier.width(8.dp));Text("Transport · work, jobs and services") }
        TextButton(onClick=openProfile) { Icon(Icons.Filled.AccountCircle,null);Spacer(Modifier.width(8.dp));Text("My listings") }
        Column {
            Text("Appearance",fontWeight=FontWeight.Medium)
            Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                Appearance.entries.forEach { option ->
                    FilterChip(selected=appearance==option,onClick={changeAppearance(option)},
                        label={Text(option.name)},shape=CircleShape)
                }
            }
        }
        NativePushToggle(model,state)
        val localModel by model.localModelState.collectAsState()
        if(ai.optBoolean("enabled")) Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            if(ai.optString("provider")=="litert" && localModel.phase in setOf(LocalModelPhase.VERIFYING,LocalModelPhase.LOADING,LocalModelPhase.REVIEWING)) {
                TextButton(onClick=model::cancelLocalAI){Text("Stop")}
            } else TextButton(enabled=!busy&&!state.demo,onClick={model.ai("check_ai")}){Text(if(ai.optString("provider")=="litert") "Check model" else "Test connection")}
        }
        if(ai.optString("provider")=="litert" && localModel.phase==LocalModelPhase.REVIEWING) {
            Text("Reviewing ${localModel.reviewed} of ${localModel.total}",color=Muted,style=MaterialTheme.typography.bodySmall)
        }
        Row(Modifier.fillMaxWidth().padding(vertical=7.dp),verticalAlignment=Alignment.CenterVertically) {
            Icon(Icons.Filled.Favorite,null,tint=Forest);Spacer(Modifier.width(12.dp));Text("Saved listings",Modifier.weight(1f));Text(state.savedCount.toString(),fontWeight=FontWeight.SemiBold)
        }
        HorizontalDivider(color=Line)
        Row(Modifier.fillMaxWidth().clickable(onClick=settings).padding(vertical=10.dp),verticalAlignment=Alignment.CenterVertically) {
            Icon(Icons.Filled.Settings,null,tint=Forest);Spacer(Modifier.width(12.dp));Text("Settings",Modifier.weight(1f));Icon(Icons.Filled.ChevronRight,null,tint=Muted)
        }
        HorizontalDivider(color=Line)
        OutlinedButton(onClick=switchMode,modifier=Modifier.fillMaxWidth(),shape=RoundedCornerShape(15.dp)) { Text(if(state.demo) "Open live market" else "Open Preview") }
    }
}
