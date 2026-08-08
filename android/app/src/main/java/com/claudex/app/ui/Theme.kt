package com.claudex.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * The in-app theme mirrors the widget's tokens exactly — same radius, same bar
 * height, same threshold palette — so the phone screen and the home screen read
 * as one product rather than two takes on it.
 */
object Tokens {
    val Radius = 16.dp
    val BarHeight = 8.dp
    val CardPadding = 16.dp
    val ScreenPadding = 16.dp

    // one neutral + two accents, and nothing else
    val Neutral = Color(0xFF7C8798)
    val Warn = Color(0xFFD9903F)
    val Alert = Color(0xFFE0563A)

    val Background = Color(0xFF0C0E12)
    val Card = Color(0xFF14171D)
    val CardLine = Color(0xFF232833)
    val Track = Color(0xFF232833)
    val Text = Color(0xFFEEF1F6)
    val TextDim = Color(0xFF98A1B0)

    fun colorFor(pct: Double?): Color = when {
        pct == null -> Neutral
        pct >= 85.0 -> Alert
        pct >= 60.0 -> Warn
        else -> Neutral
    }
}

private val ClaudexDark = darkColorScheme(
    primary = Tokens.Neutral,
    onPrimary = Tokens.Background,
    background = Tokens.Background,
    onBackground = Tokens.Text,
    surface = Tokens.Card,
    onSurface = Tokens.Text,
    surfaceVariant = Tokens.Track,
    onSurfaceVariant = Tokens.TextDim,
    outline = Tokens.CardLine,
    error = Tokens.Alert,
)

private val ClaudexLight = lightColorScheme(
    primary = Tokens.Neutral,
    background = Tokens.Background,
    onBackground = Tokens.Text,
    surface = Tokens.Card,
    onSurface = Tokens.Text,
    outline = Tokens.CardLine,
    error = Tokens.Alert,
)

@Composable
fun ClaudexTheme(content: @Composable () -> Unit) {
    // Claudex commits to its dark surface in both system themes: the widget sits on
    // a wallpaper, and a single surface colour is what keeps the two consistent.
    val scheme = if (isSystemInDarkTheme()) ClaudexDark else ClaudexLight
    MaterialTheme(colorScheme = scheme, content = content)
}
