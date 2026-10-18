package com.ellie.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "ellie_preferences")

class ServerPreferences(private val context: Context) {

    companion object {
        val KEY_BASE_URL = stringPreferencesKey("base_url")
        val KEY_CONTROL_PLANE_TOKEN = stringPreferencesKey("control_plane_token")
        val KEY_WAKE_WORD_ENABLED = booleanPreferencesKey("wake_word_enabled")
        val KEY_SPEAK_REPLIES = booleanPreferencesKey("speak_replies")

        const val DEFAULT_BASE_URL = "https://ellie-vps.example.ts.net:10000"
    }

    val baseUrl: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[KEY_BASE_URL] ?: DEFAULT_BASE_URL
    }

    val controlPlaneToken: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[KEY_CONTROL_PLANE_TOKEN] ?: ""
    }

    val wakeWordEnabled: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[KEY_WAKE_WORD_ENABLED] ?: false
    }

    val speakReplies: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[KEY_SPEAK_REPLIES] ?: true
    }

    suspend fun saveBaseUrl(url: String) {
        val trimmed = url.trim().trimEnd('/')
        context.dataStore.edit { prefs ->
            prefs[KEY_BASE_URL] = trimmed
        }
    }

    suspend fun saveControlPlaneToken(token: String) {
        context.dataStore.edit { prefs ->
            prefs[KEY_CONTROL_PLANE_TOKEN] = token.trim()
        }
    }

    suspend fun setWakeWordEnabled(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[KEY_WAKE_WORD_ENABLED] = enabled
        }
    }

    suspend fun setSpeakReplies(enabled: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[KEY_SPEAK_REPLIES] = enabled
        }
    }
}
