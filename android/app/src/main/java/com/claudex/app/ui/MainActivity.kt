package com.claudex.app.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.appwidget.updateAll
import com.claudex.app.data.CachedUsage
import com.claudex.app.data.ClaudexApi
import com.claudex.app.data.PairRequest
import com.claudex.app.data.SettingsStore
import com.claudex.app.data.UsageRepository
import com.claudex.app.data.UsageRow
import com.claudex.app.widget.ClaudexWidget
import com.claudex.app.widget.Design
import com.claudex.app.widget.RefreshWorker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The whole app UI: point it at a backend, pair providers, see the same cards the
 * widget shows. Everything beyond pairing is read-only — the phone is a thin client.
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            ClaudexTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = Tokens.Background) {
                    ClaudexScreen()
                }
            }
        }
    }
}

@Composable
private fun ClaudexScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var apiUrl by remember { mutableStateOf("") }
    var accountId by remember { mutableStateOf("") }
    var deviceSecret by remember { mutableStateOf("") }
    var cached by remember { mutableStateOf(CachedUsage()) }
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    var serviceUp by remember { mutableStateOf<Boolean?>(null) }
    var pairingCode by remember { mutableStateOf<String?>(null) }

    suspend fun reload() {
        val settings = SettingsStore.current(context)
        apiUrl = settings.apiBaseUrl
        accountId = settings.accountId
        deviceSecret = settings.deviceSecret
        cached = SettingsStore.readCachedUsage(context)
    }

    suspend fun checkHealth() {
        serviceUp = withContext(Dispatchers.IO) {
            ClaudexApi(SettingsStore.current(context).apiBaseUrl).health()
        }
    }

    /** Receives the captured cookie from the WebView and hands it to the backend. */
    val pairLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode != Activity.RESULT_OK) {
            note = "Pairing cancelled."
            return@rememberLauncherForActivityResult
        }
        val provider = result.data?.getStringExtra(PairActivity.EXTRA_PROVIDER).orEmpty()
        val token = result.data?.getStringExtra(PairActivity.EXTRA_TOKEN).orEmpty()
        if (provider.isBlank() || token.isBlank()) {
            note = "Could not read the session cookie — try signing in again."
            return@rememberLauncherForActivityResult
        }

        scope.launch {
            busy = true
            note = "Linking ${PairActivity.displayName(provider)}…"
            try {
                val settings = SettingsStore.current(context)
                val response = ClaudexApi(settings.apiBaseUrl).pair(
                    PairRequest(
                        provider = provider,
                        sessionToken = token,
                        deviceSecret = settings.deviceSecret.ifBlank { null },
                        label = android.os.Build.MODEL,
                    ),
                )
                SettingsStore.setIdentity(context, response.accountId, response.deviceSecret)
                note = "${PairActivity.displayName(provider)} linked. Fetching your first reading…"
                UsageRepository.sync(context, forceServerPoll = false)
                reload()
                ClaudexWidget().updateAll(context)
                RefreshWorker.refreshNow(context, forceServerPoll = true)
            } catch (e: ClaudexApi.ApiException) {
                note = "Backend rejected the pairing: ${e.detail}"
            } catch (e: Exception) {
                note = "Could not reach the backend: ${e.message}"
            } finally {
                busy = false
            }
        }
    }

    LaunchedEffect(Unit) {
        reload()
        checkHealth()
        if (accountId.isNotBlank()) {
            UsageRepository.sync(context, forceServerPoll = false)
            reload()
        }
    }

    fun startPairing(provider: String) {
        pairingCode = null
        note = ""
        pairLauncher.launch(
            Intent(context, PairActivity::class.java)
                .putExtra(PairActivity.EXTRA_PROVIDER, provider)
                .putExtra(PairActivity.EXTRA_LOGIN_URL, PairActivity.defaultLoginUrl(provider)),
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(Tokens.ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Claudex",
                color = Tokens.Text,
                fontSize = 24.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            if (busy) {
                CircularProgressIndicator(modifier = Modifier.width(20.dp).height(20.dp), strokeWidth = 2.dp)
            }
        }

        Text(
            text = when (serviceUp) {
                true -> "Backend reachable"
                false -> "Backend unreachable — check the URL below"
                null -> "Checking backend…"
            },
            color = if (serviceUp == false) Tokens.Alert else Tokens.TextDim,
            fontSize = 13.sp,
        )

        // ---- backend configuration ----
        SectionCard(title = "Backend") {
            OutlinedTextField(
                value = apiUrl,
                onValueChange = { apiUrl = it },
                label = { Text("API base URL") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = {
                        scope.launch {
                            SettingsStore.setApiBaseUrl(context, apiUrl)
                            reload()
                            checkHealth()
                            note = "Saved."
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Tokens.Neutral),
                ) { Text("Save") }

                OutlinedButton(onClick = {
                    scope.launch {
                        busy = true
                        UsageRepository.sync(context, forceServerPoll = true)
                        reload()
                        ClaudexWidget().updateAll(context)
                        busy = false
                    }
                }) { Text("Refresh now") }
            }
        }

        // ---- pairing ----
        SectionCard(title = "Providers") {
            Text(
                "Sign in on the provider's own site. Claudex captures the session cookie once, " +
                    "sends it to your backend over TLS, and never talks to the provider from this phone again.",
                color = Tokens.TextDim,
                fontSize = 13.sp,
            )
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = { startPairing("claude") },
                    colors = ButtonDefaults.buttonColors(containerColor = Tokens.Neutral),
                ) { Text("Pair Claude") }
                Button(
                    onClick = { startPairing("chatgpt") },
                    colors = ButtonDefaults.buttonColors(containerColor = Tokens.Neutral),
                ) { Text("Pair ChatGPT") }
            }
            Spacer(Modifier.height(8.dp))
            Text(
                "Pairing ChatGPT links Codex too — they share one account session.",
                color = Tokens.TextDim,
                fontSize = 12.sp,
            )
        }

        if (note.isNotBlank()) {
            Text(note, color = Tokens.Warn, fontSize = 13.sp)
        }

        // ---- usage cards ----
        if (cached.rows.isEmpty()) {
            SectionCard(title = "Usage") {
                Text(
                    if (accountId.isBlank()) "Nothing paired yet."
                    else "Waiting for the first reading from your backend…",
                    color = Tokens.TextDim,
                    fontSize = 13.sp,
                )
            }
        } else {
            cached.rows.forEach { row -> UsageCard(row) }
            Text(
                text = cached.lastError?.let { "Offline — showing last known values ($it)" }
                    ?: "Updated ${Design.relativeAge(cached.syncedAtMillis)}",
                color = if (cached.lastError != null) Tokens.Warn else Tokens.TextDim,
                fontSize = 12.sp,
            )
        }

        // ---- account ----
        if (accountId.isNotBlank()) {
            SectionCard(title = "Account") {
                Text("Account ID", color = Tokens.TextDim, fontSize = 12.sp)
                Text(accountId, color = Tokens.Text, fontSize = 13.sp, fontFamily = FontFamily.Monospace)
                Spacer(Modifier.height(12.dp))
                pairingCode?.let { code ->
                    Text("Dashboard pairing code", color = Tokens.TextDim, fontSize = 12.sp)
                    Text(code, color = Tokens.Text, fontSize = 20.sp, fontFamily = FontFamily.Monospace)
                    Spacer(Modifier.height(12.dp))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(onClick = {
                        scope.launch {
                            busy = true
                            note = ""
                            try {
                                pairingCode = ClaudexApi(apiUrl).pairingCode(deviceSecret).code
                            } catch (e: Exception) {
                                note = "Could not create a pairing code: ${e.message}"
                            } finally {
                                busy = false
                            }
                        }
                    }) { Text("Link dashboard") }

                    OutlinedButton(onClick = {
                        scope.launch {
                            SettingsStore.clearIdentity(context)
                            pairingCode = null
                            note = "Unpaired this device. Your backend still holds the account."
                            reload()
                            ClaudexWidget().updateAll(context)
                        }
                    }) { Text("Unpair device") }
                }
            }
        }

        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Tokens.Card, RoundedCornerShape(Tokens.Radius))
            .border(1.dp, Tokens.CardLine, RoundedCornerShape(Tokens.Radius))
            .padding(Tokens.CardPadding),
    ) {
        Text(title, color = Tokens.TextDim, fontSize = 12.sp, fontWeight = FontWeight.Medium)
        Spacer(Modifier.height(10.dp))
        content()
    }
}

@Composable
private fun UsageCard(row: UsageRow) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Tokens.Card, RoundedCornerShape(Tokens.Radius))
            .border(1.dp, Tokens.CardLine, RoundedCornerShape(Tokens.Radius))
            .padding(Tokens.CardPadding),
    ) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                row.displayName,
                color = Tokens.Text,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            Text(
                when {
                    row.needsRepair -> "needs re-pair"
                    row.isPending -> "waiting…"
                    else -> ""
                },
                color = if (row.needsRepair) Tokens.Warn else Tokens.TextDim,
                fontSize = 12.sp,
            )
        }

        Spacer(Modifier.height(14.dp))

        if (row.needsRepair) {
            Text(
                row.message ?: "Sign in again to restore this link.",
                color = Tokens.Warn,
                fontSize = 13.sp,
            )
        } else {
            Meter("Session", row.sessionPct, row.sessionResetAt)
            Spacer(Modifier.height(14.dp))
            Meter("Weekly", row.weeklyPct, row.weeklyResetAt)
        }
    }
}

@Composable
private fun Meter(label: String, pct: Double?, resetAt: String?) {
    val color = Tokens.colorFor(pct)
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(label, color = Tokens.TextDim, fontSize = 13.sp, modifier = Modifier.weight(1f))
            Text(
                Design.formatPct(pct),
                color = if (pct == null) Tokens.TextDim else color,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                // Monospace so the number's width never depends on its value.
                fontFamily = FontFamily.Monospace,
            )
        }
        Spacer(Modifier.height(6.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(Tokens.BarHeight)
                .background(Tokens.Track, RoundedCornerShape(Tokens.BarHeight / 2)),
        ) {
            val fraction = ((pct ?: 0.0) / 100.0).coerceIn(0.0, 1.0).toFloat()
            if (fraction > 0f) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth(fraction)
                        .height(Tokens.BarHeight)
                        .background(color, RoundedCornerShape(Tokens.BarHeight / 2)),
                )
            }
        }
        Design.countdown(resetAt)?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, color = Tokens.TextDim, fontSize = 12.sp)
        }
    }
}
