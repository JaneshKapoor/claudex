package com.claudex.app.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * The API's `/v1/usage` row, verbatim. The app is a thin client: it never computes
 * usage, it only renders what the backend already resolved and cached.
 */
@Serializable
data class UsageRow(
    val provider: String,
    val displayName: String = provider,
    val sessionPct: Double? = null,
    val weeklyPct: Double? = null,
    val sessionResetAt: String? = null,
    val weeklyResetAt: String? = null,
    val lastFetchedAt: String? = null,
    val status: String = "pending",
    val message: String? = null,
) {
    val needsRepair: Boolean get() = status == "needs_repair"
    val isPending: Boolean get() = status == "pending"
}

@Serializable
data class ProviderInfo(
    val id: String,
    val displayName: String,
    val repairHint: String = "",
    val loginUrl: String = "",
    val pairable: Boolean = true,
)

@Serializable
data class ProvidersResponse(val providers: List<ProviderInfo> = emptyList())

@Serializable
data class PairRequest(
    val provider: String,
    val sessionToken: String,
    val deviceSecret: String? = null,
    val platform: String = "android",
    val label: String? = null,
)

@Serializable
data class PairResponse(
    val accountId: String,
    val deviceId: String? = null,
    val deviceSecret: String? = null,
    val provider: String? = null,
    val status: String? = null,
)

@Serializable
data class PairingCodeResponse(
    val code: String,
    val expiresAt: String? = null,
    val linkUrl: String? = null,
    val qrUrl: String? = null,
)

@Serializable
data class ApiError(
    val error: String = "unknown",
    val detail: String? = null,
)

/** What the widget renders from — the last good payload plus when it arrived. */
@Serializable
data class CachedUsage(
    @SerialName("rows") val rows: List<UsageRow> = emptyList(),
    @SerialName("syncedAtMillis") val syncedAtMillis: Long = 0L,
    /** Set when the most recent sync attempt failed; the old rows still render. */
    @SerialName("lastError") val lastError: String? = null,
)
