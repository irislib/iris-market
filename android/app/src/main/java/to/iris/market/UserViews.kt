package to.iris.market

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable fun UserAvatar(person: PublicPerson, size: Dp = 40.dp) {
    val photo by produceState<android.graphics.Bitmap?>(null, person.pictureUrl) {
        value = person.pictureUrl?.let { withContext(Dispatchers.IO) { loadPhoto(it) } }
    }
    val accent=Forest
    Box(Modifier.size(size).clip(CircleShape).background(Mint)) {
        if(photo!=null) Image(photo!!.asImageBitmap(),null,Modifier.fillMaxSize(),contentScale=ContentScale.Crop)
        else Canvas(Modifier.fillMaxSize()) {
            val bytes=person.author.toByteArray(); val cell=this.size.width/7f
            for(row in 0..4) for(column in 0..2) {
                val value=if(bytes.isEmpty()) row+column else bytes[(row*3+column)%bytes.size].toInt()
                if(value and 1 == 1) for(x in setOf(column,4-column)) {
                    drawRoundRect(accent,Offset((x+1)*cell,(row+1)*cell),Size(cell,cell),CornerRadius(cell*.2f))
                }
            }
        }
    }
}

@Composable fun UserName(person: PublicPerson, style: TextStyle = MaterialTheme.typography.bodyMedium) {
    Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(5.dp)) {
        Text(person.name.ifBlank { "Unnamed user" },Modifier.weight(1f,false),style=style,fontWeight=FontWeight.Medium,maxLines=1,overflow=TextOverflow.Ellipsis)
        ConnectionBadge(person.connection)
    }
}

@Composable fun UserRow(person: PublicPerson, subtitle: String? = null, size: Dp=40.dp) {
    Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
        UserAvatar(person,size)
        Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(4.dp)) {
            UserName(person)
            if(!subtitle.isNullOrBlank()) Text(subtitle,color=Muted,style=MaterialTheme.typography.bodySmall,maxLines=2,overflow=TextOverflow.Ellipsis)
        }
    }
}
