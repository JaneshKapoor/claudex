package com.claudex.app.widget

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.unit.ColorProvider
import com.claudex.app.R
import java.time.Duration
import java.time.Instant
import java.time.format.DateTimeParseException

/**
 * The widget's design tokens, in one place.
 *
 * The spec is strict about consistency, and the only way to guarantee it is to
 * have exactly one definition of each value. Nothing below may be overridden at a
 * call site: every card gets the same radius, every bar the same height and the
 * same horizontal inset, on every provider.
 */
object Design {

    /** The one radius token. Cards use it; bars use a pill radius from the drawable. */
    val Radius: Dp = 16.dp

    val WidgetPadding: Dp = 12.dp
    val CardPadding: Dp = 14.dp
    val CardSpacing: Dp = 10.dp

    /** Identical on every bar, on every card. */
    val BarHeight: Dp = 8.dp
    val BarSpacing: Dp = 12.dp

    /** Fixed so all three cards are the same height whatever state they are in. */
    val CardHeight: Dp = 144.dp

    val TitleSize = 14.sp
    val StateSize = 11.sp
    val LabelSize = 11.sp
    val ValueSize = 13.sp
    val ResetSize = 10.sp

    // One neutral plus two accents — the entire palette.
    val Neutral = ColorProvider(Color(0xFF7C8798))
    val Warn = ColorProvider(Color(0xFFD9903F))
    val Alert = ColorProvider(Color(0xFFE0563A))

    val Text = ColorProvider(Color(0xFFEEF1F6))
    val TextDim = ColorProvider(Color(0xFF98A1B0))

    /** Threshold scale, shared with the dashboard. Colour tracks pressure, not brand. */
    enum class Level { NEUTRAL, WARN, ALERT }

    fun levelFor(pct: Double?): Level = when {
        pct == null -> Level.NEUTRAL
        pct >= 85.0 -> Level.ALERT
        pct >= 60.0 -> Level.WARN
        else -> Level.NEUTRAL
    }

    fun fillDrawable(level: Level): Int = when (level) {
        Level.NEUTRAL -> R.drawable.bar_fill_neutral
        Level.WARN -> R.drawable.bar_fill_warn
        Level.ALERT -> R.drawable.bar_fill_alert
    }

    fun textColorFor(level: Level): ColorProvider = when (level) {
        Level.NEUTRAL -> Text
        Level.WARN -> Warn
        Level.ALERT -> Alert
    }

    /**
     * Percentages are rendered at a fixed width so a change from "9%" to "89%"
     * never nudges anything. Combined with a monospace font this keeps the whole
     * column of numbers on a single vertical rule.
     */
    fun formatPct(pct: Double?): String = when (pct) {
        null -> "  –"
        else -> "%3d%%".format(pct.coerceIn(0.0, 100.0).toInt())
    }

    /** "resets in 2h 14m" — always relative, never a raw timestamp. */
    fun countdown(iso: String?): String? {
        val instant = parseInstant(iso) ?: return null
        val remaining = Duration.between(Instant.now(), instant)
        if (remaining.isNegative || remaining.isZero) return "resetting now"
        val days = remaining.toDays()
        val hours = remaining.toHours() % 24
        val minutes = remaining.toMinutes() % 60
        return when {
            days > 0 -> "resets in ${days}d ${hours}h"
            hours > 0 -> "resets in ${hours}h ${"%02d".format(minutes)}m"
            else -> "resets in ${minutes}m"
        }
    }

    fun relativeAge(millis: Long): String {
        if (millis <= 0L) return "not synced yet"
        val minutes = Duration.ofMillis(System.currentTimeMillis() - millis).toMinutes()
        return when {
            minutes < 1 -> "just now"
            minutes < 60 -> "${minutes}m ago"
            minutes < 1440 -> "${minutes / 60}h ago"
            else -> "${minutes / 1440}d ago"
        }
    }

    private fun parseInstant(iso: String?): Instant? {
        if (iso.isNullOrBlank()) return null
        return try {
            Instant.parse(iso)
        } catch (_: DateTimeParseException) {
            null
        }
    }

    /**
     * Bar fill width in dp. Glance has no fractional widths, so the fill is sized
     * against the measured widget width. A non-zero percentage always renders at
     * least a visible nub rather than disappearing.
     */
    fun fillWidth(available: Dp, pct: Double?): Dp {
        if (pct == null || pct <= 0.0) return 0.dp
        val fraction = (pct / 100.0).coerceIn(0.0, 1.0)
        val width = available * fraction.toFloat()
        return if (width < BarHeight) BarHeight else width
    }
}
