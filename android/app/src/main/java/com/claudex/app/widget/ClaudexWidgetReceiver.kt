package com.claudex.app.widget

import android.content.Context
import android.content.Intent
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.updateAll
import androidx.glance.action.ActionParameters

class ClaudexWidgetReceiver : GlanceAppWidgetReceiver() {

    override val glanceAppWidget: GlanceAppWidget = ClaudexWidget()

    /** First widget placed: start the refresh cadence. */
    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        RefreshWorker.schedulePeriodic(context)
        RefreshWorker.refreshNow(context, forceServerPoll = false)
    }

    /** Last widget removed: stop doing background work nobody can see. */
    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        RefreshWorker.cancelPeriodic(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == AppWidgetManagerUpdate) {
            RefreshWorker.refreshNow(context, forceServerPoll = false)
        }
    }

    private companion object {
        const val AppWidgetManagerUpdate = "android.appwidget.action.APPWIDGET_UPDATE"
    }
}

/** Tapping the timestamp in the widget header asks the backend for a live poll. */
class RefreshAction : ActionCallback {
    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters,
    ) {
        RefreshWorker.refreshNow(context, forceServerPoll = true)
        ClaudexWidget().updateAll(context)
    }
}
