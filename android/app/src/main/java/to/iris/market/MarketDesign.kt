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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.asImageBitmap
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
val Ink: Color @Composable get() = MaterialTheme.colorScheme.onSurface
val Action: Color @Composable get() = MaterialTheme.colorScheme.primary
val OnInk: Color @Composable get() = MaterialTheme.colorScheme.onPrimary
val Forest: Color @Composable get() = MaterialTheme.colorScheme.secondary
val Mint: Color @Composable get() = MaterialTheme.colorScheme.primaryContainer
val Sand: Color @Composable get() = MaterialTheme.colorScheme.tertiaryContainer
val Muted: Color @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant
val Line: Color @Composable get() = MaterialTheme.colorScheme.outlineVariant
val White: Color @Composable get() = MaterialTheme.colorScheme.surfaceContainer

private val LightColors = lightColorScheme(
    primary = Color(0xFF252525), onPrimary = Color.White,
    primaryContainer = Color(0xFFF0EFF4), onPrimaryContainer = Color(0xFF222222),
    secondary = Color(0xFF252525), onSecondary = Color.White,
    secondaryContainer = Color(0xFFF0EFF4), onSecondaryContainer = Color(0xFF222222),
    tertiary = Color(0xFF252525), onTertiary = Color.White,
    tertiaryContainer = Color(0xFFF3F3F5), onTertiaryContainer = Color(0xFF222222),
    surface = Color(0xFFFFFFFF), surfaceContainer = Color(0xFFF7F7F8), surfaceContainerHigh = Color(0xFFF3F3F5),
    surfaceContainerHighest = Color(0xFFF0EFF4), surfaceContainerLow = Color(0xFFF7F7F8), surfaceContainerLowest = Color.White,
    surfaceDim = Color(0xFFE5E5E7), surfaceBright = Color.White, surfaceTint = Color(0xFF252525),
    background = Color.White, onSurface = Color(0xFF222222), onSurfaceVariant = Color(0xFF686868),
    onBackground = Color(0xFF222222), outline = Color(0xFF686868), outlineVariant = Color(0xFFE5E5E7),
    inverseSurface = Color(0xFF222222), inverseOnSurface = Color.White, inversePrimary = Color(0xFFF0EFF4),
    scrim = Color(0xFF18181B))
private val DarkColors = darkColorScheme(
    primary = Color(0xFFC2B5F5), onPrimary = Color(0xFF252036),
    primaryContainer = Color(0xFF2D293C), onPrimaryContainer = Color(0xFFEEEEF2),
    secondary = Color(0xFFC2B5F5), secondaryContainer = Color(0xFF2D293C), onSecondaryContainer = Color(0xFFEEEEF2),
    tertiary = Color(0xFFC2B5F5), tertiaryContainer = Color(0xFF292D36), onTertiaryContainer = Color(0xFFEEEEF2),
    surface = Color(0xFF14161B), surfaceContainer = Color(0xFF1D2027), surfaceContainerHigh = Color(0xFF292D36),
    surfaceContainerHighest = Color(0xFF292D36), surfaceContainerLow = Color(0xFF1D2027), surfaceContainerLowest = Color(0xFF14161B),
    background = Color(0xFF14161B), onSurface = Color(0xFFEEEEF2), onSurfaceVariant = Color(0xFFA5A8B3),
    onBackground = Color(0xFFEEEEF2), outline = Color(0xFFA5A8B3), outlineVariant = Color(0xFF343842))

@Composable fun MarketTheme(dark: Boolean, content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) DarkColors else LightColors,
        typography = Typography(
            headlineLarge = MaterialTheme.typography.headlineLarge.copy(fontSize = 34.sp, lineHeight = 38.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-1.2).sp),
            headlineMedium = MaterialTheme.typography.headlineMedium.copy(fontSize = 28.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-.7).sp),
            titleLarge = MaterialTheme.typography.titleLarge.copy(fontSize = 23.sp, letterSpacing = (-.5).sp),
            bodyLarge = MaterialTheme.typography.bodyLarge.copy(fontSize = 16.sp, lineHeight = 23.sp)), content = content)
}

@Composable fun IrisMark(modifier: Modifier = Modifier) {
    val paths = remember { listOf(
        PathParser().parsePathString("M7 32a25 25 0 0 1 40-20V7a1 1 0 0 1 1.7-.7L59 17a1.4 1.4 0 0 1 0 2L48.7 29.7A1 1 0 0 1 47 29v-6a15 15 0 0 0-30 9Z").toPath(),
        PathParser().parsePathString("M57 32a25 25 0 0 1-40 20v5a1 1 0 0 1-1.7.7L5 47a1.4 1.4 0 0 1 0-2l10.3-10.7A1 1 0 0 1 17 35v6a15 15 0 0 0 30-9Z").toPath()
    ) }
    Canvas(modifier) {
        val scale = minOf(size.width, size.height) / 64f
        withTransform({ scale(scale, scale, pivot = Offset.Zero) }) {
            val gradient = Brush.linearGradient(listOf(Color(0xFF8458DC), Color(0xFFC859A5), Color(0xFFF18A58)), Offset(8f,56f), Offset(56f,8f))
            paths.forEach { drawPath(it, gradient) }
        }
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
        value = null
        if (!demo && listing.imageUrl != null) value = withContext(Dispatchers.IO) { loadPhoto(listing.imageUrl) }
    }
    if (photo != null) Image(photo!!.asImageBitmap(), listing.title, modifier.background(White), contentScale = ContentScale.Fit)
    else BoxWithConstraints(modifier.background(White), contentAlignment = Alignment.Center) {
        val service = listing.category.trim().lowercase() in setOf("service", "services", "help", "skills", "jobs", "delivery", "errands")
        Icon(if (service) Icons.Default.Work else Icons.Default.LocalOffer, contentDescription = null,
            modifier = Modifier.size(minOf(maxWidth, maxHeight) * 0.24f), tint = Color.Gray.copy(alpha = 0.20f))
    }
}

internal fun loadPhoto(source: String): Bitmap? = runCatching {
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
