package com.claudex.app.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The only network client in the app.
 *
 * After pairing, Claudex talks to its own API and nothing else — provider tokens
 * are handed over once and never used from the device again. The manifest sets
 * `usesCleartextTraffic="false"`, so this is TLS-only by construction.
 */
class ClaudexApi(private val baseUrl: String) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(45, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    class ApiException(val status: Int, val detail: String) : IOException(detail)

    private fun url(path: String) = baseUrl.trimEnd('/') + path

    private inline fun <reified T> parse(body: String): T = SettingsStore.json.decodeFromString(body)

    private fun failureDetail(status: Int, body: String): String =
        runCatching { SettingsStore.json.decodeFromString<ApiError>(body) }
            .getOrNull()?.detail
            ?: "request failed (HTTP $status)"

    private suspend fun execute(request: Request): String = withContext(Dispatchers.IO) {
        client.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw ApiException(response.code, failureDetail(response.code, body))
            }
            body
        }
    }

    suspend fun health(): Boolean = runCatching {
        execute(Request.Builder().url(url("/health")).get().build())
        true
    }.getOrDefault(false)

    suspend fun providers(): List<ProviderInfo> {
        val body = execute(Request.Builder().url(url("/v1/providers")).get().build())
        return parse<ProvidersResponse>(body).providers
    }

    suspend fun usage(accountId: String): List<UsageRow> {
        val body = execute(
            Request.Builder().url(url("/v1/usage?accountId=$accountId")).get().build(),
        )
        return parse(body)
    }

    /** Hands a freshly captured provider session token to the backend, once. */
    suspend fun pair(request: PairRequest): PairResponse {
        val payload = SettingsStore.json.encodeToString(PairRequest.serializer(), request)
        val body = execute(
            Request.Builder()
                .url(url("/v1/pair"))
                .post(payload.toRequestBody(jsonMedia))
                .build(),
        )
        return parse(body)
    }

    /** Asks the backend to poll now. Best-effort: the widget still renders without it. */
    suspend fun refresh(deviceSecret: String): Boolean = runCatching {
        execute(
            Request.Builder()
                .url(url("/v1/refresh"))
                .header("x-claudex-device", deviceSecret)
                .post(ByteArray(0).toRequestBody(jsonMedia))
                .build(),
        )
        true
    }.getOrDefault(false)

    /** Issues a code so the web dashboard can join this same account. */
    suspend fun pairingCode(deviceSecret: String): PairingCodeResponse {
        val body = execute(
            Request.Builder()
                .url(url("/v1/pair/code"))
                .header("x-claudex-device", deviceSecret)
                .post(ByteArray(0).toRequestBody(jsonMedia))
                .build(),
        )
        return parse(body)
    }

    suspend fun unlink(deviceSecret: String, provider: String): Boolean = runCatching {
        execute(
            Request.Builder()
                .url(url("/v1/link/$provider"))
                .header("x-claudex-device", deviceSecret)
                .delete()
                .build(),
        )
        true
    }.getOrDefault(false)

    companion object {
        suspend fun forContext(context: Context): ClaudexApi =
            ClaudexApi(SettingsStore.current(context).apiBaseUrl)
    }
}
