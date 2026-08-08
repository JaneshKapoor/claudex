package com.claudex.app.widget

import android.content.Context
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.updateAll
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.claudex.app.data.UsageRepository
import java.util.concurrent.TimeUnit

/**
 * Keeps the widget's local cache fresh.
 *
 * The heavy lifting — talking to the providers — happens on the backend, so this
 * only pulls an already-computed payload. That is why it can run on a modest
 * cadence and still show current numbers.
 */
class RefreshWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val forcePoll = inputData.getBoolean(KEY_FORCE_POLL, false)
        val result = UsageRepository.sync(applicationContext, forceServerPoll = forcePoll)

        // Redraw regardless of outcome — a failed sync still has a defined state
        // to render (previous rows plus an "offline" marker).
        ClaudexWidget().updateAll(applicationContext)

        return when (result) {
            is UsageRepository.SyncResult.Success -> Result.success()
            is UsageRepository.SyncResult.NotPaired -> Result.success()
            // Retry with WorkManager's backoff rather than hammering on a flaky network.
            is UsageRepository.SyncResult.Failed -> if (runAttemptCount < 3) Result.retry() else Result.success()
        }
    }

    companion object {
        private const val PERIODIC_NAME = "claudex-periodic-refresh"
        private const val KEY_FORCE_POLL = "force_poll"

        /**
         * 15 minutes is WorkManager's floor. The backend polls providers every
         * ~25 minutes, so this pulls the cached result promptly without ever
         * causing extra provider traffic.
         */
        fun schedulePeriodic(context: Context) {
            val request = PeriodicWorkRequestBuilder<RefreshWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }

        /** Fired by the widget's refresh tap and after pairing. */
        fun refreshNow(context: Context, forceServerPoll: Boolean = true) {
            val request = OneTimeWorkRequestBuilder<RefreshWorker>()
                .setInputData(androidx.work.workDataOf(KEY_FORCE_POLL to forceServerPoll))
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .build()
            WorkManager.getInstance(context).enqueue(request)
        }

        fun cancelPeriodic(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(PERIODIC_NAME)
        }

        suspend fun hasWidgets(context: Context): Boolean =
            GlanceAppWidgetManager(context).getGlanceIds(ClaudexWidget::class.java).isNotEmpty()
    }
}
