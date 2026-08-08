package com.claudex.app.ui

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback

/**
 * One-time provider pairing.
 *
 * The user signs in to claude.ai / chatgpt.com in a plain WebView, on the
 * provider's own domain — Claudex never sees a password and never proxies the
 * login. Once the provider sets its session cookie we read that single cookie,
 * hand it to the Claudex backend over TLS, and never touch the provider again
 * from this device.
 *
 * Two things make this fiddlier than it looks, and both are handled below:
 *
 *  1. **"Continue with Google" opens a popup.** The provider calls `window.open`,
 *     so without [WebChromeClient.onCreateWindow] the popup has nowhere to render
 *     and the screen just goes black. We host popups in a second WebView stacked
 *     on top, sharing the same cookie jar.
 *  2. **There is no reliable "you are logged in now" navigation.** These are SPAs;
 *     the session cookie can appear without any page load finishing. So we poll the
 *     cookie jar on a timer as well as on page events, and offer a manual button.
 */
class PairActivity : ComponentActivity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var status: TextView
    private var popup: WebView? = null

    private var provider: String = ""
    private var finished = false

    private val handler = Handler(Looper.getMainLooper())
    private val poller = object : Runnable {
        override fun run() {
            if (finished) return
            tryCaptureToken()
            handler.postDelayed(this, POLL_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        provider = intent.getStringExtra(EXTRA_PROVIDER).orEmpty()
        val loginUrl = intent.getStringExtra(EXTRA_LOGIN_URL).orEmpty()
            .ifBlank { defaultLoginUrl(provider) }

        root = FrameLayout(this).apply { setBackgroundColor(BACKGROUND) }

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(BACKGROUND)
            val pad = dp(12)
            setPadding(pad, pad, pad, pad)
        }

        status = TextView(this).apply {
            text = "Sign in to ${displayName(provider)}"
            setTextColor(TEXT_DIM)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }

        // Escape hatch: if a provider sets its cookie in a way our polling misses,
        // the user can still force the capture once they can see they are signed in.
        val doneButton = Button(this).apply {
            text = "I'm signed in"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setOnClickListener {
                if (!tryCaptureToken()) {
                    status.text = "No session cookie yet — finish signing in, then tap again."
                }
            }
        }

        bar.addView(status)
        bar.addView(doneButton)

        webView = WebView(this)
        configureWebView(webView)

        root.addView(
            webView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ).apply { topMargin = dp(56) },
        )
        root.addView(
            bar,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56))
                .apply { gravity = Gravity.TOP },
        )
        setContentView(root)

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    // Back should dismiss the Google popup, not the whole flow.
                    popup != null -> closePopup()
                    webView.canGoBack() -> webView.goBack()
                    else -> finishCancelled()
                }
            }
        })

        webView.loadUrl(loginUrl)
        handler.postDelayed(poller, POLL_MS)
    }

    private fun configureWebView(view: WebView) {
        view.setBackgroundColor(BACKGROUND)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            // Google's OAuth screen opens itself in a new window.
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            // The default WebView UA contains "; wv", which Google's sign-in rejects
            // outright. Presenting as ordinary mobile Chrome keeps the flow available.
            userAgentString = MOBILE_UA
        }

        view.webViewClient = object : WebViewClient() {
            override fun onPageStarted(v: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(v, url, favicon)
                tryCaptureToken()
            }

            override fun onPageFinished(v: WebView?, url: String?) {
                super.onPageFinished(v, url)
                tryCaptureToken()
            }
        }

        view.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(
                v: WebView,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message,
            ): Boolean {
                // Host the popup in a real WebView stacked on top; it shares the
                // process-wide cookie jar, so whatever it sets we can still read.
                closePopup()
                val child = WebView(this@PairActivity)
                configureWebView(child)
                CookieManager.getInstance().setAcceptThirdPartyCookies(child, true)
                popup = child
                root.addView(
                    child,
                    FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    ).apply { topMargin = dp(56) },
                )
                (resultMsg.obj as WebView.WebViewTransport).webView = child
                resultMsg.sendToTarget()
                return true
            }

            override fun onCloseWindow(window: WebView) {
                closePopup()
                tryCaptureToken()
            }
        }
    }

    private fun closePopup() {
        popup?.let { child ->
            root.removeView(child)
            child.destroy()
        }
        popup = null
    }

    /** @return true when a cookie was found and the activity is finishing. */
    private fun tryCaptureToken(): Boolean {
        if (finished) return true
        val token = readSessionCookie(provider) ?: return false
        finished = true
        handler.removeCallbacks(poller)
        status.text = "Signed in. Linking to Claudex…"
        setResult(
            Activity.RESULT_OK,
            Intent().putExtra(EXTRA_PROVIDER, provider).putExtra(EXTRA_TOKEN, token),
        )
        finish()
        return true
    }

    private fun finishCancelled() {
        handler.removeCallbacks(poller)
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

    override fun onDestroy() {
        handler.removeCallbacks(poller)
        closePopup()
        super.onDestroy()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val EXTRA_PROVIDER = "provider"
        const val EXTRA_LOGIN_URL = "login_url"
        const val EXTRA_TOKEN = "token"

        private const val POLL_MS = 1_500L
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
