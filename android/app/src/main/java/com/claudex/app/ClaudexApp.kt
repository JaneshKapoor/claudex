package com.claudex.app

import android.app.Application
import com.claudex.app.widget.RefreshWorker

class ClaudexApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Idempotent (KEEP policy) — safe to call on every cold start.
        RefreshWorker.schedulePeriodic(this)
    }
}
