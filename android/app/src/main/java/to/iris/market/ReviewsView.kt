package to.iris.market

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONArray

internal data class MarketReview(val id:String,val author:String,val body:String,val rating:Double,val ratingMax:Int,val person:PublicPerson) {
    companion object { fun parse(raw:String):List<MarketReview> {val rows=JSONArray(raw);return (0 until rows.length()).map {val r=rows.getJSONObject(it);MarketReview(r.getString("id"),r.getString("author"),r.getString("body"),r.getDouble("rating"),r.getInt("ratingMax"),PublicPerson.parse(r.getJSONObject("person")))}} }
}
@Composable internal fun ReviewsView(target:String,model:MarketModel,product:Boolean=false) {
    val state by model.state.collectAsState()
    key(target,state.publicKey,state.demo) { ReviewsContent(target,model,product,state) }
}
@Composable private fun ReviewsContent(target:String,model:MarketModel,product:Boolean,state:MarketSnapshot) {
    val scope=rememberCoroutineScope()
    var reviews by remember(target){mutableStateOf(emptyList<MarketReview>())}
    var loading by remember(target){mutableStateOf(false)};var expanded by remember(target){mutableStateOf(false)}
    var writing by remember(target){mutableStateOf(false)};var rating by remember(target){mutableIntStateOf(5)}
    var body by remember(target){mutableStateOf("")};var publishing by remember(target){mutableStateOf(false)}
    var failed by remember(target){mutableStateOf(false)}
    LaunchedEffect(target) {
        loading=true
        runCatching {model.loadReviews(target,product,false)}.onSuccess {reviews=it}
        runCatching {model.loadReviews(target,product,true)}.onSuccess {reviews=it}
        loading=false
    }
    Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
            TextButton(onClick={expanded=!expanded}) {Text("${reviews.size} reviews")}
            if(loading)CircularProgressIndicator(Modifier.size(20.dp))
            if(!product&&target!=state.publicKey&&state.canSign&&!state.demo) TextButton(onClick={writing=!writing;expanded=true}) {Text(if(writing) "Cancel" else "Write a review")}
        }
        if(writing) {
            Row { (1..5).forEach {value->IconButton(onClick={rating=value}) {Icon(if(value<=rating)Icons.Filled.Star else Icons.Filled.StarBorder,"$value stars")}} }
            OutlinedTextField(body,{body=it},label={Text("Your experience · optional")},modifier=Modifier.fillMaxWidth(),minLines=3)
            Text("Your review will be public.",style=MaterialTheme.typography.bodySmall,color=Muted)
            if(failed)Text("Could not save your review. Your draft is still here.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.error)
            Button(enabled=!publishing&&body.length<=3000&&!state.demo&&state.canSign,onClick={publishing=true;failed=false;scope.launch {
                try {reviews=model.publishReview(target,rating,body,state.publicKey);writing=false;body=""}
                catch(e:kotlinx.coroutines.CancellationException){throw e}
                catch(_:Exception){failed=true}
                finally{publishing=false}
            }}) {Text(if(publishing) "Publishing…" else "Publish review")}
        }
        if(expanded)reviews.forEach { review->
            Column(Modifier.padding(vertical=6.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
                UserRow(review.person)
                Text(if(review.ratingMax==5) "★".repeat(review.rating.toInt())+"☆".repeat(5-review.rating.toInt()) else "${(review.rating*100).toInt()}% positive")
                if(review.body.isNotEmpty())Text(review.body)
            }
        }
    }
}
