package com.claudex.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.claudex.app.BuildConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "claudex")

/**
 * Everything the client persists. Deliberately small: a base URL, the account it
 * belongs to, the device secret, and the last usage payload so the widget always
 * has something defined to draw.
 */
data class ClaudexSettings(
    val apiBaseUrl: String,
    val accountId: String,
    val deviceSecret: String,
) {
    val isPaired: Boolean get() = accountId.isNotBlank()
}

object SettingsStore {

    private val KEY_API_URL = stringPreferencesKey("api_base_url")
    private val KEY_ACCOUNT_ID = stringPreferencesKey("account_id")
    private val KEY_DEVICE_SECRET = stringPreferencesKey("device_secret")
    private val KEY_CACHED_USAGE = stringPreferencesKey("cached_usage")

    val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        // Omit null fields entirely rather than sending `"deviceSecret": null`.
        // On a first pair there is no device secret yet, and an explicit null is a
        // different thing from an absent field to most request validators.
        explicitNulls = false
    }

    fun settings(context: Context): Flow<ClaudexSettings> =
        context.dataStore.data.map { prefs ->
            ClaudexSettings(
                apiBaseUrl = prefs[KEY_API_URL]?.takeIf { it.isNotBlank() }
                    ?: BuildConfig.DEFAULT_API_BASE_URL,
                accountId = prefs[KEY_ACCOUNT_ID].orEmpty(),
                deviceSecret = prefs[KEY_DEVICE_SECRET].orEmpty(),
            )
        }

    suspend fun current(context: Context): ClaudexSettings = settings(context).first()

    suspend fun setApiBaseUrl(context: Context, url: String) {
        context.dataStore.edit { it[KEY_API_URL] = url.trim().trimEnd('/') }
    }

    suspend fun setIdentity(context: Context, accountId: String, deviceSecret: String?) {
        context.dataStore.edit { prefs ->
            prefs[KEY_ACCOUNT_ID] = accountId
            // The server only issues a device secret on the very first pair; later
            // pairs reuse the one we already hold.
            if (!deviceSecret.isNullOrBlank()) prefs[KEY_DEVICE_SECRET] = deviceSecret
        }
    }

    suspend fun clearIdentity(context: Context) {
        context.dataStore.edit { prefs ->
            prefs.remove(KEY_ACCOUNT_ID)
            prefs.remove(KEY_DEVICE_SECRET)
            prefs.remove(KEY_CACHED_USAGE)
        }
    }

    fun cachedUsage(context: Context): Flow<CachedUsage> =
        context.dataStore.data.map { prefs -> decodeUsage(prefs[KEY_CACHED_USAGE]) }

    suspend fun readCachedUsage(context: Context): CachedUsage = cachedUsage(context).first()

    suspend fun writeCachedUsage(context: Context, usage: CachedUsage) {
        context.dataStore.edit {
            it[KEY_CACHED_USAGE] = json.encodeToString(CachedUsage.serializer(), usage)
        }
    }

    private fun decodeUsage(raw: String?): CachedUsage =
        if (raw.isNullOrBlank()) CachedUsage()
        else runCatching { json.decodeFromString<CachedUsage>(raw) }.getOrElse { CachedUsage() }
}
