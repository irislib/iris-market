package to.iris.market

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import org.json.JSONObject

data class LocalChatRetention(val mode:String="follow", val seconds:Long?=null)
private val units = listOf("days" to 86400L,"hours" to 3600L,"minutes" to 60L,"seconds" to 1L)
private fun duration(seconds:Long?):String {
    if(seconds==null || seconds<=0) return "Off"
    val (label,unit)=units.first { seconds % it.second == 0L }
    val n=seconds/unit
    return "$n "+if(n==1L) label.dropLast(1) else label
}
@Composable internal fun ChatTimerControl(state:MarketSnapshot, model:MarketModel, peer:String?=null) {
    var editing by remember(state.publicKey,peer) {mutableStateOf(false)}
    val local=state.chatRetention
    val shared=state.conversations.firstOrNull {it.id==peer}?.timerSeconds
    val summary=when(local.mode) {
        "keep"->"Keep all messages on this device"
        "expire"->"Delete all messages on this device after "+duration(local.seconds)
        else->"Follow the conversation timer"
    }
    TextButton(onClick={editing=true},enabled=!state.demo&&(peer==null || state.messagingReady)){
        Text(if(peer==null)"Message retention" else "Conversation timer · "+duration(shared))
    }
    val description=when(local.mode) {
        "keep"->"This device keeps sent and received messages."
        "expire"->"This device deletes sent and received messages after "+duration(local.seconds)+"."
        else->"This device follows the conversation timer."
    }
    Text(if(peer==null)summary else "$description Each participant can keep their own copies.",color=Muted,style=MaterialTheme.typography.bodySmall)
    if(!editing)return
    val seconds=(if(peer==null)local.seconds else shared) ?: 86400L
    var unit by remember {mutableStateOf(units.first { seconds % it.second==0L }.second)}
    var number by remember {mutableStateOf((seconds/unit).toString())}
    var mode by remember {mutableStateOf(if(peer==null)local.mode else if(shared==null)"off" else "expire")}
    val value=number.toLongOrNull()?.takeIf {it>0 && it<=4294967295L/unit}?.times(unit)
    val choices=if(peer==null) listOf("follow" to "Follow the conversation timer","keep" to "Keep all messages on this device","expire" to "Delete all messages on this device after…") else listOf("off" to "Off","expire" to "Expire new messages after…")
    var menu by remember {mutableStateOf(false)}
    var unitMenu by remember {mutableStateOf(false)}
    AlertDialog(onDismissRequest={editing=false}, title={Text(if(peer==null)"Message retention" else "Conversation timer")},
        text={Column(verticalArrangement=Arrangement.spacedBy(8.dp)){
            Text(if(peer==null)"Applies to all sent and received messages in every chat for this profile on this device. Deleted messages cannot be restored." else "This timer applies to new messages for both participants. Each person can keep messages or choose another duration on their own device.")
            Box { TextButton(modifier=Modifier.testTag("chatTimerMode"),onClick={menu=true}){Text(choices.first {it.first==mode}.second)}
                DropdownMenu(expanded=menu,onDismissRequest={menu=false}) {choices.forEach { (id,label)-> DropdownMenuItem(text={Text(label)},onClick={mode=id;menu=false})}} }
            if(mode=="expire"){
                OutlinedTextField(modifier=Modifier.testTag("chatTimerDuration"),value=number,onValueChange={number=it}, singleLine=true,label={Text("Duration")},keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Number))
                Box {TextButton(modifier=Modifier.testTag("chatTimerUnit"),onClick={unitMenu=true}){Text(units.first {it.second==unit}.first)}
                    DropdownMenu(expanded=unitMenu,onDismissRequest={unitMenu=false}){units.forEach{(label,n)-> DropdownMenuItem(text={Text(label)},onClick={unit=n;unitMenu=false})}}}
            }
        }},
        dismissButton={TextButton(onClick={editing=false}){Text("Cancel")}},
        confirmButton={TextButton(modifier=Modifier.testTag("chatTimerSave"),enabled=mode!="expire"||value!=null,onClick={
            val action=if(peer==null)JSONObject().put("type","set_chat_retention").put("policy",JSONObject().put("mode",mode).apply{if(mode=="expire")put("seconds",value)})
                else JSONObject().put("type","set_chat_timer").put("peer_id",peer).put("seconds",if(mode=="expire")value else JSONObject.NULL)
            model.command(action){editing=false}
        }){Text("Save")}})
}
