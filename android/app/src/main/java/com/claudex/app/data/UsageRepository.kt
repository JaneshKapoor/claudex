package com.claudex.app.data

import android.content.Context
import android.util.Log

/**
 * Single place that turns "go get the usage" into a cached payload the widget and
 * the app both read. A failed sync never clears the last good rows — the widget
 * would rather show slightly stale numbers than an empty tile.
 */
object UsageRepository {

    private const val TAG = "ClaudexUsage"

    sealed interface SyncResult {
        data class Success(val rows: List<UsageRow>) : SyncResult
        data object NotPaired : SyncResult
        data class Failed(val detail: String) : SyncResult
    }

    suspend fun sync(context: Context, forceServerPoll: Boolean = false): SyncResult {
        val settings = SettingsStore.current(context)
        if (!settings.isPaired) return SyncResult.NotPaired

        val api = ClaudexApi(settings.apiBaseUrl)

        if (forceServerPoll && settings.deviceSecret.isNotBlank()) {
            // Best-effort: if this fails we still read whatever the poller last stored.
            api.refresh(settings.deviceSecret)
        }

        return try {
            val rows = api.usage(settings.accountId)
            SettingsStore.writeCachedUsage(
                context,
                CachedUsage(rows = rows, syncedAtMillis = System.currentTimeMillis()),
            )
            SyncResult.Success(rows)
        } catch (e: ClaudexApi.ApiException) {
            Log.w(TAG, "usage sync rejected: HTTP ${e.status} ${e.detail}")
            markStale(context, e.detail)
            SyncResult.Failed(e.detail)
        } catch (e: Exception) {
            Log.w(TAG, "usage sync failed: ${e.message}")
            markStale(context, e.message ?: "network unavailable")
            SyncResult.Failed(e.message ?: "network unavailable")
        }
    }

    /** Keeps the previous rows, records why they are not fresh. */
    private suspend fun markStale(context: Context, detail: String) {
        val previous = SettingsStore.readCachedUsage(context)
        SettingsStore.writeCachedUsage(context, previous.copy(lastError = detail))
    }
}
