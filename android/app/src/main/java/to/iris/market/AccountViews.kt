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
import org.json.JSONObject

@Composable fun InboxView(state:MarketSnapshot,model:MarketModel,busy:Boolean) {
    var selected by remember { mutableStateOf<String?>(null) }
    var pasted by remember { mutableStateOf("") };var showConnect by remember { mutableStateOf(false) }
    val clipboard=LocalClipboardManager.current
    val conversation=state.conversations.firstOrNull{it.id==selected}
    if(conversation != null) {
        ConversationView(conversation,model,busy){selected=null};return
    }
    Column(Modifier.fillMaxSize().padding(horizontal=22.dp)) {
        Row(Modifier.padding(top=15.dp,bottom=8.dp).fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
            Text("Inbox",style=MaterialTheme.typography.headlineMedium)
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
            items(state.conversations,key={it.id}) { c ->
                Surface(color=White,shape=RoundedCornerShape(20.dp),modifier=Modifier.fillMaxWidth().clickable{selected=c.id}) {
                    Row(Modifier.padding(16.dp),verticalAlignment=Alignment.CenterVertically) {
                        Box(Modifier.size(47.dp).background(Mint,CircleShape),contentAlignment=Alignment.Center) { Text(c.name.take(1).uppercase(),fontWeight=FontWeight.SemiBold) }
                        Spacer(Modifier.width(13.dp));Column(Modifier.weight(1f)) {
                            Text(c.name,fontWeight=FontWeight.SemiBold,maxLines=1,overflow=TextOverflow.Ellipsis)
                            Spacer(Modifier.height(5.dp));Text(c.messages.lastOrNull()?.text ?: "No messages",color=Muted,maxLines=1,overflow=TextOverflow.Ellipsis,style=MaterialTheme.typography.bodyMedium)
                        }
                        Icon(Icons.Filled.ChevronRight,null,tint=Muted)
                    }
                }
            }
        }
    }
}

@Composable fun ConversationView(c:Conversation,model:MarketModel,busy:Boolean,back:()->Unit) {
    var message by remember(c.id) { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(horizontal=18.dp).imePadding()) {
        Row(verticalAlignment=Alignment.CenterVertically) {
            IconButton(onClick=back){Icon(Icons.Filled.ArrowBack,"Back to inbox")}
            Column { Text(c.name,fontWeight=FontWeight.SemiBold);Text("Private conversation",color=Muted,style=MaterialTheme.typography.labelSmall) }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(),contentPadding=PaddingValues(vertical=18.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
            items(c.messages,key={it.id}) { m ->
                Row(Modifier.fillMaxWidth(),horizontalArrangement=if(m.mine) Arrangement.End else Arrangement.Start) {
                    Surface(color=if(m.mine) Ink else White,contentColor=if(m.mine) OnInk else Ink,
                        shape=RoundedCornerShape(19.dp),modifier=Modifier.widthIn(max=290.dp)) {
                        Text(m.text,Modifier.padding(horizontal=15.dp,vertical=12.dp),style=MaterialTheme.typography.bodyLarge)
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(bottom=12.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(7.dp)) {
            OutlinedTextField(value=message,onValueChange={message=it},placeholder={Text("Write a message")},modifier=Modifier.weight(1f),
                shape=RoundedCornerShape(23.dp),maxLines=4,colors=OutlinedTextFieldDefaults.colors(unfocusedBorderColor=Line))
            FilledIconButton(enabled=message.isNotBlank()&&!busy,onClick={
                model.command(JSONObject().put("type","send_message").put("peer_id",c.id).put("text",message.trim())){message=""}
            }) { Icon(Icons.Filled.ArrowUpward,"Send message") }
        }
    }
}

@Composable fun ProfileView(state:MarketSnapshot,busy:Boolean,settings:()->Unit,switchMode:()->Unit,model:MarketModel,appearance:Appearance,changeAppearance:(Appearance)->Unit) {
    val ai=remember(state.settings){JSONObject(state.settings).optJSONObject("ai")?:JSONObject()}
    val clipboard=LocalClipboardManager.current
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal=24.dp).padding(bottom=35.dp),verticalArrangement=Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(7.dp))
        Text("Account",style=MaterialTheme.typography.headlineMedium)
        Row(verticalAlignment=Alignment.CenterVertically,modifier=Modifier.padding(vertical=10.dp)) {
            Box(Modifier.size(70.dp).background(Mint,RoundedCornerShape(25.dp)),contentAlignment=Alignment.Center){Icon(Icons.Filled.Person,null,Modifier.size(34.dp),tint=Forest)}
            Spacer(Modifier.width(17.dp));Column { Text(if(state.demo) "Preview account" else "Your account",style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.SemiBold)
                Text(if(state.demo) "Sample listings. No network activity." else "Identity stored on this device.",color=Muted,style=MaterialTheme.typography.bodySmall) }
        }
        Column {
            Text("Appearance",fontWeight=FontWeight.Medium)
            Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                Appearance.entries.forEach { option ->
                    FilterChip(selected=appearance==option,onClick={changeAppearance(option)},
                        label={Text(option.name)},shape=CircleShape)
                }
            }
        }
        if(ai.optBoolean("enabled")) Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            OutlinedButton(enabled=!busy&&!state.demo,onClick={model.ai("curate")},shape=CircleShape){Text("Curate listings")}
            TextButton(enabled=!busy&&!state.demo,onClick={model.ai("check_ai")}){Text("Test connection")}
        }
        Row(Modifier.fillMaxWidth().padding(vertical=7.dp),verticalAlignment=Alignment.CenterVertically) {
            Icon(Icons.Filled.Bookmark,null,tint=Forest);Spacer(Modifier.width(12.dp));Text("Saved listings",Modifier.weight(1f));Text(state.savedCount.toString(),fontWeight=FontWeight.SemiBold)
        }
        HorizontalDivider(color=Line)
        Row(Modifier.fillMaxWidth().clickable(onClick=settings).padding(vertical=10.dp),verticalAlignment=Alignment.CenterVertically) {
            Icon(Icons.Filled.Settings,null,tint=Forest);Spacer(Modifier.width(12.dp));Text("AI settings",Modifier.weight(1f));Icon(Icons.Filled.ChevronRight,null,tint=Muted)
        }
        HorizontalDivider(color=Line)
        if(state.publicKey.isNotBlank()) TextButton(onClick={clipboard.setText(AnnotatedString(state.publicKey))}) {
            Icon(Icons.Filled.ContentCopy,null,Modifier.size(16.dp));Spacer(Modifier.width(7.dp));Text("Copy account ID")
        }
        Text(state.status,color=Muted,style=MaterialTheme.typography.bodySmall)
        state.error?.let { Text(it,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall) }
        OutlinedButton(onClick=switchMode,modifier=Modifier.fillMaxWidth(),shape=RoundedCornerShape(15.dp)) { Text(if(state.demo) "Open live market" else "Open Preview") }
        Text("Iris Market · 0.1.0",color=Muted,style=MaterialTheme.typography.labelSmall,modifier=Modifier.align(Alignment.CenterHorizontally))
    }
}
