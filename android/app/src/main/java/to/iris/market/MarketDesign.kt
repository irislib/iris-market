package to.iris.market

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI

enum class Appearance { System, Light, Dark }

val Cream: Color @Composable get() = MaterialTheme.colorScheme.background
val Ink: Color @Composable get() = MaterialTheme.colorScheme.primary
val OnInk: Color @Composable get() = MaterialTheme.colorScheme.onPrimary
val Forest: Color @Composable get() = MaterialTheme.colorScheme.secondary
val Mint: Color @Composable get() = MaterialTheme.colorScheme.primaryContainer
val Sand: Color @Composable get() = MaterialTheme.colorScheme.tertiaryContainer
val Muted: Color @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant
val Line: Color @Composable get() = MaterialTheme.colorScheme.outlineVariant
val White: Color @Composable get() = MaterialTheme.colorScheme.surfaceContainer

private val LightColors = lightColorScheme(
    primary = Color(0xFF173C34), onPrimary = Color.White,
    primaryContainer = Color(0xFFDDE8D7), onPrimaryContainer = Color(0xFF173C34),
    secondary = Color(0xFF386452), secondaryContainer = Color(0xFFDDE8D7), onSecondaryContainer = Color(0xFF173C34),
    tertiary = Color(0xFF386452), tertiaryContainer = Color(0xFFF0E5CB), onTertiaryContainer = Color(0xFF173C34),
    surface = Color(0xFFF7F6EF), surfaceContainer = Color(0xFFFFFEF8), surfaceContainerHigh = Color(0xFFFFFEF8),
    surfaceContainerHighest = Color(0xFFE2E4D9), surfaceContainerLow = Color(0xFFF7F6EF), surfaceContainerLowest = Color(0xFFFFFEF8),
    background = Color(0xFFF7F6EF), onSurface = Color(0xFF173C34), onSurfaceVariant = Color(0xFF727C73),
    onBackground = Color(0xFF173C34), outline = Color(0xFF727C73), outlineVariant = Color(0xFFE2E4D9))
private val DarkColors = darkColorScheme(
    primary = Color(0xFFE0EAD9), onPrimary = Color(0xFF173C34),
    primaryContainer = Color(0xFF284438), onPrimaryContainer = Color(0xFFE0EAD9),
    secondary = Color(0xFFB1CDB5), secondaryContainer = Color(0xFF284438), onSecondaryContainer = Color(0xFFE0EAD9),
    tertiary = Color(0xFFDBC79E), tertiaryContainer = Color(0xFF413B29), onTertiaryContainer = Color(0xFFEEDDB6),
    surface = Color(0xFF111C17), surfaceContainer = Color(0xFF1B2922), surfaceContainerHigh = Color(0xFF24342B),
    surfaceContainerHighest = Color(0xFF34463B), surfaceContainerLow = Color(0xFF17241D), surfaceContainerLowest = Color(0xFF0D1712),
    background = Color(0xFF111C17), onSurface = Color(0xFFE5EBDD), onSurfaceVariant = Color(0xFFA9B6AA),
    onBackground = Color(0xFFE5EBDD), outline = Color(0xFF819184), outlineVariant = Color(0xFF34463B))

@Composable fun MarketTheme(dark: Boolean, content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) DarkColors else LightColors,
        typography = Typography(
            headlineLarge = MaterialTheme.typography.headlineLarge.copy(fontSize = 34.sp, lineHeight = 38.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-1.2).sp),
            headlineMedium = MaterialTheme.typography.headlineMedium.copy(fontSize = 28.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-.7).sp),
            titleLarge = MaterialTheme.typography.titleLarge.copy(fontSize = 23.sp, letterSpacing = (-.5).sp),
            bodyLarge = MaterialTheme.typography.bodyLarge.copy(fontSize = 16.sp, lineHeight = 23.sp)), content = content)
}

@Composable fun IrisMark(modifier: Modifier = Modifier) {
    val ink = Ink; val cream = Cream
    Canvas(modifier) {
        val r = size.width * .23f
        for (p in listOf(Offset(.5f,.25f),Offset(.75f,.5f),Offset(.5f,.75f),Offset(.25f,.5f)))
            drawCircle(ink, r, Offset(size.width*p.x,size.height*p.y))
        drawCircle(cream, size.width * .12f, center)
    }
}

@Composable fun EmptyView(title: String, body: String, icon: ImageVector, action: String? = null, onAction: () -> Unit = {}) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 30.dp, vertical = 46.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Surface(color = Mint, shape = RoundedCornerShape(28.dp)) { Icon(icon, null, Modifier.padding(24.dp).size(34.dp), tint = Forest) }
        Spacer(Modifier.height(22.dp)); Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(9.dp)); Text(body, color = Muted, style = MaterialTheme.typography.bodyMedium,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        if (action != null) { Spacer(Modifier.height(22.dp)); Button(onClick = onAction) { Text(action) } }
    }
}

@Composable fun ListingArt(listing: Listing, demo: Boolean, modifier: Modifier = Modifier) {
    val photo by produceState<Bitmap?>(null, listing.imageUrl, demo) {
        if (!demo && listing.imageUrl != null) value = withContext(Dispatchers.IO) { loadPhoto(listing.imageUrl) }
    }
    if (photo != null) Image(photo!!.asImageBitmap(), listing.title, modifier, contentScale = ContentScale.Crop)
    else CategoryArt(listing.category, listing.title, modifier)
}

private fun loadPhoto(source: String): Bitmap? = runCatching {
    val url = URI(source).toURL()
    if (url.protocol != "https") return null
    val c = url.openConnection() as HttpURLConnection
    c.connectTimeout = 6_000; c.readTimeout = 6_000; c.instanceFollowRedirects = false
    try {
        if (c.responseCode != 200 || c.contentLengthLong > 4_000_000) return null
        val bytes = c.inputStream.use { input ->
            val out = ByteArrayOutputStream(); val chunk = ByteArray(16_384)
            while (true) { val count = input.read(chunk); if (count < 0) break
                if (out.size() + count > 4_000_000) return null
                out.write(chunk, 0, count) }
            out.toByteArray()
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val factor = maxOf(1, maxOf(bounds.outWidth, bounds.outHeight) / 900)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = factor })
    } finally { c.disconnect() }
}.getOrNull()

@Composable fun CategoryArt(category: String, title: String, modifier: Modifier = Modifier) {
    val ink = Color(0xFF173C34); val forest = Color(0xFF386452); val sand = Color(0xFFF0E5CB)
    val type = when {
        title.contains("green",true) || title.contains("plant",true) -> 0
        title.contains("camera",true) || category.contains("photography",true) -> 5
        title.contains("music",true) || title.contains("headphone",true) -> 6
        title.contains("coffee",true) -> 7
        (category+title).contains("bike", true) || category.contains("transport",true) || category.contains("sport",true) -> 1
        category.contains("elect",true) || title.contains("monitor",true) || title.contains("camera",true) -> 2
        category.contains("home",true) || category.contains("furn",true) || title.contains("chair",true) -> 3
        category.contains("service",true) || category.contains("work",true) || category.contains("task",true) -> 4
        else -> 0
    }
    val background = listOf(Color(0xFFE9EDD8), Color(0xFFDDE8D9), Color(0xFFE0E5E9), Color(0xFFECE0CE), Color(0xFFE8E2EE),Color(0xFFDDDCD3),Color(0xFFE8D8CB),Color(0xFFE2DED0))[type]
    Canvas(modifier.background(background)) {
        withTransform({ scale(size.width / 200f, size.height / 160f, Offset.Zero) }) {
            drawCircle(Color.White.copy(alpha=.24f), 63f, Offset(151f,28f))
            drawOval(ink.copy(alpha=.10f), Offset(30f,126f), Size(145f,16f))
            when (type) {
                5 -> {
                    drawRoundRect(ink,Offset(43f,58f),Size(118f,65f),CornerRadius(10f))
                    drawRoundRect(ink,Offset(66f,47f),Size(42f,22f),CornerRadius(5f))
                    drawRoundRect(Color(0xFF718278),Offset(43f,58f),Size(118f,15f),CornerRadius(7f))
                    drawCircle(Color(0xFFC5CCC4),31f,Offset(108f,90f));drawCircle(ink,25f,Offset(108f,90f))
                    drawCircle(Color(0xFF57756A),16f,Offset(108f,90f));drawCircle(Color(0xFF9BB5AB),6f,Offset(114f,84f))
                    drawRoundRect(sand,Offset(51f,66f),Size(19f,10f),CornerRadius(2f))
                }
                6 -> {
                    drawArc(ink,180f,180f,false,Offset(55f,28f),Size(90f,104f),style=Stroke(12f))
                    drawRoundRect(Color(0xFFAA7354),Offset(43f,78f),Size(30f,52f),CornerRadius(13f))
                    drawRoundRect(Color(0xFFAA7354),Offset(127f,78f),Size(30f,52f),CornerRadius(13f))
                    drawRoundRect(ink,Offset(65f,82f),Size(10f,45f),CornerRadius(4f))
                    drawRoundRect(ink,Offset(125f,82f),Size(10f,45f),CornerRadius(4f))
                }
                7 -> {
                    drawRoundRect(Color(0xFF9C7856),Offset(75f,59f),Size(53f,73f),CornerRadius(8f))
                    drawRoundRect(ink,Offset(73f,55f),Size(57f,12f),CornerRadius(4f))
                    drawLine(ink,Offset(101f,55f),Offset(101f,42f),5f);drawLine(ink,Offset(101f,42f),Offset(146f,42f),5f)
                    drawRoundRect(ink,Offset(137f,32f),Size(21f,12f),CornerRadius(5f))
                    drawLine(Color(0xFFCCB194),Offset(82f,72f),Offset(82f,118f),3f)
                }
                1 -> {
                    drawCircle(ink, 28f, Offset(52f,110f), style=Stroke(5f)); drawCircle(ink,28f,Offset(151f,110f),style=Stroke(5f))
                    val frame = Path().apply { moveTo(52f,110f);lineTo(78f,66f);lineTo(110f,110f);close();moveTo(78f,66f);lineTo(133f,66f);lineTo(110f,110f);moveTo(151f,110f);lineTo(128f,49f);lineTo(144f,49f) }
                    drawPath(frame, Color(0xFFB45E3D), style=Stroke(6f)); drawLine(ink,Offset(68f,58f),Offset(89f,58f),6f); drawLine(ink,Offset(78f,58f),Offset(78f,69f),5f)
                }
                2 -> {
                    drawRoundRect(ink,Offset(35f,35f),Size(130f,81f),CornerRadius(7f))
                    drawRoundRect(Color(0xFFAFC6BA),Offset(42f,42f),Size(116f,66f),CornerRadius(3f))
                    val mountains=Path().apply { moveTo(42f,108f);lineTo(86f,60f);lineTo(111f,92f);lineTo(134f,72f);lineTo(158f,108f);close() }
                    drawPath(mountains, Color(0xFF75978C));drawCircle(Color(0xFFEEDDB6),10f,Offset(132f,60f))
                    drawRect(ink,Offset(94f,114f),Size(12f,18f));drawRoundRect(ink,Offset(76f,130f),Size(48f,5f),CornerRadius(2f))
                }
                3 -> {
                    drawRoundRect(Color(0xFF987C58),Offset(54f,31f),Size(92f,69f),CornerRadius(18f))
                    drawRoundRect(Color(0xFFC1A276),Offset(48f,83f),Size(104f,24f),CornerRadius(8f))
                    drawLine(ink,Offset(60f,104f),Offset(54f,137f),7f);drawLine(ink,Offset(140f,104f),Offset(147f,137f),7f)
                    drawRoundRect(Color(0xFFDFCBAA),Offset(69f,43f),Size(62f,38f),CornerRadius(12f))
                }
                4 -> {
                    drawRoundRect(Color(0xFF7C7B98),Offset(48f,55f),Size(110f,76f),CornerRadius(11f))
                    drawRoundRect(Color(0xFF7C7B98),Offset(80f,35f),Size(45f,38f),CornerRadius(9f),style=Stroke(6f))
                    drawRect(Color(0xFFACA7C1),Offset(48f,82f),Size(110f,14f));drawRoundRect(sand,Offset(95f,82f),Size(17f,24f),CornerRadius(3f))
                    drawCircle(Color(0xFFCBC5DE),18f,Offset(150f,35f));drawLine(ink,Offset(144f,35f),Offset(149f,40f),3f);drawLine(ink,Offset(149f,40f),Offset(158f,29f),3f)
                }
                else -> {
                    drawRoundRect(Color(0xFFB98254),Offset(75f,91f),Size(49f,42f),CornerRadius(8f))
                    drawLine(ink,Offset(100f,101f),Offset(100f,41f),4f)
                    drawOval(forest,Offset(57f,38f),Size(43f,25f));drawOval(Color(0xFF709575),Offset(100f,56f),Size(42f,25f))
                    drawOval(Color(0xFF89A482),Offset(76f,15f),Size(27f,42f));drawOval(forest,Offset(61f,71f),Size(40f,23f))
                }
            }
        }
    }
}
