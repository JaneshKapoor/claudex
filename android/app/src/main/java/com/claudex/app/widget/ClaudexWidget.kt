package com.claudex.app.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.ImageProvider
import androidx.glance.LocalSize
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontFamily
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import com.claudex.app.R
import com.claudex.app.data.CachedUsage
import com.claudex.app.data.SettingsStore
import com.claudex.app.data.UsageRow
import com.claudex.app.ui.MainActivity

/**
 * The Claudex home-screen widget.
 *
 * It reads only from local storage — never the network — so it renders instantly
 * and can never show a spinner because a provider is slow. WorkManager keeps that
 * storage fresh in the background (see [RefreshWorker]).
 */
class ClaudexWidget : GlanceAppWidget() {

    // Exact so the fill widths can be computed against the real measured width.
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val settings = SettingsStore.current(context)
        val cached = SettingsStore.readCachedUsage(context)

        provideContent {
            GlanceTheme {
                WidgetBody(paired = settings.isPaired, cached = cached)
            }
        }
    }

    @Composable
    private fun WidgetBody(paired: Boolean, cached: CachedUsage) {
        // Width available to a bar: widget padding and card padding on both sides.
        val barWidth: Dp = LocalSize.current.width -
            (Design.WidgetPadding * 2) - (Design.CardPadding * 2)

        Column(
            modifier = GlanceModifier
                .fillMaxSize()
                .background(ImageProvider(R.drawable.widget_bg))
                .padding(Design.WidgetPadding),
        ) {
            Header(cached)
            Spacer(GlanceModifier.height(Design.CardSpacing))

            when {
                !paired -> SetupCard("Open Claudex to pair a provider")
                cached.rows.isEmpty() && cached.syncedAtMillis == 0L ->
                    // Never a blank tile: skeletons stand in until the first sync lands.
                    Column(modifier = GlanceModifier.fillMaxWidth()) {
                        SkeletonCard("Claude", barWidth)
                        Spacer(GlanceModifier.height(Design.CardSpacing))
                        SkeletonCard("ChatGPT", barWidth)
                    }
                cached.rows.isEmpty() -> SetupCard("No providers linked yet — open Claudex")
                else -> LazyColumn(modifier = GlanceModifier.fillMaxSize()) {
                    items(cached.rows, itemId = { it.provider.hashCode().toLong() }) { row ->
                        Column {
                            ProviderCard(row, barWidth)
                            Spacer(GlanceModifier.height(Design.CardSpacing))
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun Header(cached: CachedUsage) {
        Row(
            modifier = GlanceModifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "Claudex",
                style = TextStyle(
                    color = Design.Text,
                    fontSize = Design.TitleSize,
                    fontWeight = FontWeight.Medium,
                ),
                modifier = GlanceModifier.defaultWeight(),
            )
            Text(
                text = if (cached.lastError != null) {
                    "offline · ${Design.relativeAge(cached.syncedAtMillis)}"
                } else {
                    Design.relativeAge(cached.syncedAtMillis)
                },
                style = TextStyle(color = Design.TextDim, fontSize = Design.StateSize),
                // Tapping the timestamp forces a refresh; tapping a card opens the app.
                modifier = GlanceModifier.clickable(actionRunCallback<RefreshAction>()),
            )
        }
    }

    /** Cards are a fixed height so no state — normal, skeleton, repair — resizes the grid. */
    @Composable
    private fun CardFrame(content: @Composable () -> Unit) {
        Box(
            modifier = GlanceModifier
                .fillMaxWidth()
                .height(Design.CardHeight)
                .background(ImageProvider(R.drawable.card_bg))
                .padding(Design.CardPadding)
                .clickable(actionStartActivity<MainActivity>()),
        ) {
            content()
        }
    }

    @Composable
    private fun ProviderCard(row: UsageRow, barWidth: Dp) {
        CardFrame {
            Column(modifier = GlanceModifier.fillMaxSize()) {
                CardHeader(
                    title = row.displayName,
                    state = when {
                        row.needsRepair -> "needs re-pair"
                        row.isPending -> "waiting…"
                        else -> ""
                    },
                )
                Spacer(GlanceModifier.height(Design.BarSpacing))

                if (row.needsRepair) {
                    Text(
                        text = row.message ?: "Sign in again in Claudex to restore this link.",
                        style = TextStyle(color = Design.Warn, fontSize = Design.LabelSize),
                        maxLines = 3,
                    )
                } else {
                    Meter("Session", row.sessionPct, row.sessionResetAt, barWidth, row.isPending)
                    Spacer(GlanceModifier.height(Design.BarSpacing))
                    Meter("Weekly", row.weeklyPct, row.weeklyResetAt, barWidth, row.isPending)
                }
            }
        }
    }

    @Composable
    private fun SkeletonCard(title: String, barWidth: Dp) {
        CardFrame {
            Column(modifier = GlanceModifier.fillMaxSize()) {
                CardHeader(title = title, state = "loading…")
                Spacer(GlanceModifier.height(Design.BarSpacing))
                Meter("Session", null, null, barWidth, pending = true)
                Spacer(GlanceModifier.height(Design.BarSpacing))
                Meter("Weekly", null, null, barWidth, pending = true)
            }
        }
    }

    @Composable
    private fun SetupCard(message: String) {
        CardFrame {
            Box(
                modifier = GlanceModifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = message,
                    style = TextStyle(color = Design.TextDim, fontSize = Design.ValueSize),
                    maxLines = 2,
                )
            }
        }
    }

    @Composable
    private fun CardHeader(title: String, state: String) {
        Row(
            modifier = GlanceModifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = title,
                style = TextStyle(
                    color = Design.Text,
                    fontSize = Design.TitleSize,
                    fontWeight = FontWeight.Medium,
                ),
                modifier = GlanceModifier.defaultWeight(),
                maxLines = 1,
            )
            if (state.isNotEmpty()) {
                Text(
                    text = state,
                    style = TextStyle(color = Design.TextDim, fontSize = Design.StateSize),
                    maxLines = 1,
                )
            }
        }
    }

    /**
     * One bar. Every instance of this composable produces an identical geometry —
     * same height, same pill radius, same inset — which is what stops the two bars
     * on a card, and the cards themselves, from drifting apart visually.
     */
    @Composable
    private fun Meter(
        label: String,
        pct: Double?,
        resetAt: String?,
        barWidth: Dp,
        pending: Boolean,
    ) {
        val level = Design.levelFor(pct)
        val reset = Design.countdown(resetAt)

        Column(modifier = GlanceModifier.fillMaxWidth()) {
            Row(
                modifier = GlanceModifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = label,
                    style = TextStyle(color = Design.TextDim, fontSize = Design.LabelSize),
                    modifier = GlanceModifier.defaultWeight(),
                    maxLines = 1,
                )
                Text(
                    text = Design.formatPct(pct),
                    style = TextStyle(
                        color = if (pending) Design.TextDim else Design.textColorFor(level),
                        fontSize = Design.ValueSize,
                        fontWeight = FontWeight.Medium,
                        // Tabular figures: the number's width must not depend on its value.
                        fontFamily = FontFamily.Monospace,
                    ),
                    maxLines = 1,
                )
            }

            Spacer(GlanceModifier.height(4.dp))

            Box(
                modifier = GlanceModifier
                    .fillMaxWidth()
                    .height(Design.BarHeight)
                    .background(ImageProvider(R.drawable.bar_track)),
            ) {
                val fill = Design.fillWidth(barWidth, pct)
                if (fill > 0.dp) {
                    Box(
                        modifier = GlanceModifier
                            .width(fill)
                            .height(Design.BarHeight)
                            .background(ImageProvider(Design.fillDrawable(level))),
                    ) {}
                }
            }

            if (reset != null) {
                Spacer(GlanceModifier.height(4.dp))
                Text(
                    text = reset,
                    style = TextStyle(color = Design.TextDim, fontSize = Design.ResetSize),
                    maxLines = 1,
                )
            }
        }
    }
}
