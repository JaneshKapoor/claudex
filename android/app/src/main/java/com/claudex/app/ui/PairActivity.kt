package com.claudex.app.ui

import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import android.content.Intent
import android.graphics.Color
import android.util.TypedValue
import android.view.Gravity

/**
 * One-time provider pairing.
 *
 * The user signs in to claude.ai / chatgpt.com in a plain WebView, on the
 * provider's own domain — Claudex never sees a password and never proxies the
 * login. Once the provider sets its session cookie we read that single cookie,
 * hand it to the Claudex backend over TLS, and never touch the provider again
 * from this device.
 */
class PairActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var status: TextView
    private var provider: String = ""
    private var finished = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        provider = intent.getStringExtra(EXTRA_PROVIDER).orEmpty()
        val loginUrl = intent.getStringExtra(EXTRA_LOGIN_URL).orEmpty().ifBlank { defaultLoginUrl(provider) }

        val root = FrameLayout(this).apply { setBackgroundColor(BACKGROUND) }

        status = TextView(this).apply {
            text = "Sign in to ${displayName(provider)}. Claudex reads only the session cookie."
            setTextColor(TEXT_DIM)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            val pad = dp(14)
            setPadding(pad, pad, pad, pad)
        }

        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ).apply { topMargin = dp(48) }
            setBackgroundColor(BACKGROUND)
        }

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            // The default WebView UA contains "; wv", which some login flows reject.
            userAgentString = MOBILE_UA
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                tryCaptureToken()
            }
        }

        root.addView(
            status,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(48),
            ).apply { gravity = Gravity.TOP },
        )
        root.addView(webView)
        setContentView(root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finishCancelled()
            }
        })

        webView.loadUrl(loginUrl)
    }

    /**
     * Providers set their session cookie at some point during the login dance —
     * there is no reliable "logged in" navigation to hook — so we check after every
     * page load and finish the moment the cookie exists.
     */
    private fun tryCaptureToken() {
        if (finished) return
        val token = readSessionCookie(provider) ?: return
        finished = true
        status.text = "Signed in. Linking to Claudex…"
        setResult(
            Activity.RESULT_OK,
            Intent().putExtra(EXTRA_PROVIDER, provider).putExtra(EXTRA_TOKEN, token),
        )
        finish()
    }

    private fun finishCancelled() {
        setResult(Activity.RESULT_CANCELED)
        finish()
    }

    private fun readSessionCookie(provider: String): String? {
        val origin = when (provider) {
            "claude" -> "https://claude.ai"
            else -> "https://chatgpt.com"
        }
        val raw = CookieManager.getInstance().getCookie(origin) ?: return null
        val jar = raw.split(';')
            .mapNotNull { part ->
                val idx = part.indexOf('=')
                if (idx <= 0) null else part.substring(0, idx).trim() to part.substring(idx + 1).trim()
            }
            .toMap()

        return when (provider) {
            "claude" -> jar["sessionKey"]?.takeIf { it.isNotBlank() }
            else -> {
                // NextAuth splits an oversized session JWT across .0, .1, ... cookies.
                val chunks = jar.keys
                    .filter { it.startsWith("__Secure-next-auth.session-token.") }
                    .sortedBy { it.substringAfterLast('.').toIntOrNull() ?: 0 }
                when {
                    chunks.isNotEmpty() -> chunks.joinToString("") { jar[it].orEmpty() }
                    else -> jar["__Secure-next-auth.session-token"]?.takeIf { it.isNotBlank() }
                }
            }
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val EXTRA_PROVIDER = "provider"
        const val EXTRA_LOGIN_URL = "login_url"
        const val EXTRA_TOKEN = "token"

        private const val BACKGROUND = 0xFF0C0E12.toInt()
        private val TEXT_DIM = Color.parseColor("#98A1B0")

        private const val MOBILE_UA =
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/131.0.0.0 Mobile Safari/537.36"

        fun defaultLoginUrl(provider: String): String = when (provider) {
            "claude" -> "https://claude.ai/login"
            else -> "https://chatgpt.com/auth/login"
        }

        fun displayName(provider: String): String = when (provider) {
            "claude" -> "Claude"
            "codex" -> "Codex"
            else -> "ChatGPT"
        }
    }
}
