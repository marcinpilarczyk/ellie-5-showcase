package com.ellie.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class EllieApiClient(private val prefs: ServerPreferences) {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = true
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .build()

    private suspend fun getBaseUrl(): String {
        return prefs.baseUrl.first().trim().trimEnd('/')
    }

    private suspend fun getToken(): String {
        return prefs.controlPlaneToken.first().trim()
    }

    private suspend fun buildRequest(
        path: String,
        method: String = "GET",
        bodyJson: String? = null
    ): Request {
        val base = getBaseUrl()
        val token = getToken()
        val url = "$base$path"

        val requestBuilder = Request.Builder().url(url)
        if (token.isNotEmpty()) {
            requestBuilder.header("Authorization", "Bearer $token")
        }

        when (method.uppercase()) {
            "GET" -> requestBuilder.get()
            "POST" -> {
                val reqBody = (bodyJson ?: "{}").toRequestBody(jsonMediaType)
                requestBuilder.post(reqBody)
            }
            "PUT" -> {
                val reqBody = (bodyJson ?: "{}").toRequestBody(jsonMediaType)
                requestBuilder.put(reqBody)
            }
            "DELETE" -> requestBuilder.delete()
        }

        return requestBuilder.build()
    }

    private suspend inline fun <reified T> execute(
        path: String,
        method: String = "GET",
        bodyJson: String? = null
    ): Result<T> = withContext(Dispatchers.IO) {
        try {
            val request = buildRequest(path, method, bodyJson)
            client.newCall(request).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                if (!response.isSuccessful && bodyStr.isBlank()) {
                    return@withContext Result.failure(IOException("HTTP ${response.code}: ${response.message}"))
                }
                try {
                    val parsed = json.decodeFromString<T>(bodyStr)
                    Result.success(parsed)
                } catch (e: Exception) {
                    Result.failure(IOException("Failed to parse response (HTTP ${response.code}): ${e.message}\nRaw: $bodyStr", e))
                }
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    // ==========================================
    // Queue API
    // ==========================================

    suspend fun getQueue(): Result<QueueResponse> {
        return execute("/api/queue")
    }

    suspend fun approveAction(actionId: String, actor: String = "android_app"): Result<ActionOutcomeResponse> {
        val body = buildJsonObject { put("actor", actor) }.toString()
        return execute("/api/queue/$actionId/approve", method = "POST", bodyJson = body)
    }

    suspend fun dropAction(actionId: String, actor: String = "android_app", reason: String? = null): Result<SimpleSuccessResponse> {
        val body = buildJsonObject {
            put("actor", actor)
            reason?.let { put("reason", it) }
        }.toString()
        return execute("/api/queue/$actionId/drop", method = "POST", bodyJson = body)
    }

    suspend fun updateStagedPayload(
        actionId: String,
        payload: JsonObject,
        actor: String = "android_app"
    ): Result<SimpleSuccessResponse> {
        val body = buildJsonObject {
            put("actor", actor)
            put("payload", payload)
        }.toString()
        return execute("/api/queue/$actionId", method = "PUT", bodyJson = body)
    }

    suspend fun approveAllBatch(batchId: String? = null, actor: String = "android_app"): Result<SimpleSuccessResponse> {
        val body = buildJsonObject {
            put("actor", actor)
            batchId?.let { put("batch_id", it) }
        }.toString()
        return execute("/api/queue/batch/approve-all", method = "POST", bodyJson = body)
    }

    suspend fun dropAllBatch(batchId: String? = null, actor: String = "android_app", reason: String? = null): Result<SimpleSuccessResponse> {
        val body = buildJsonObject {
            put("actor", actor)
            batchId?.let { put("batch_id", it) }
            reason?.let { put("reason", it) }
        }.toString()
        return execute("/api/queue/batch/drop-all", method = "POST", bodyJson = body)
    }

    // ==========================================
    // Ops API (Routines, Sentinels, Traces, Costs)
    // ==========================================

    suspend fun getOpsStatus(): Result<OpsStatusResponse> {
        return execute("/api/ops/status")
    }

    suspend fun getRoutines(): Result<RoutinesResponse> {
        return execute("/api/ops/routines")
    }

    suspend fun toggleRoutine(routineId: String): Result<SimpleSuccessResponse> {
        return execute("/api/ops/routines/$routineId/toggle", method = "POST")
    }

    suspend fun updateRoutine(
        routineId: String,
        title: String,
        cronSchedule: String,
        destination: String? = "Slack",
        description: String? = null,
        isActive: Int? = null
    ): Result<SimpleSuccessResponse> {
        val body = buildJsonObject {
            put("title", title)
            put("cron_schedule", cronSchedule)
            destination?.let { put("destination", it) }
            description?.let { put("description", it) }
            isActive?.let { put("is_active", it) }
        }.toString()
        return execute("/api/ops/routines/$routineId", method = "PUT", bodyJson = body)
    }

    suspend fun deleteRoutine(routineId: String): Result<SimpleSuccessResponse> {
        return execute("/api/ops/routines/$routineId", method = "DELETE")
    }

    suspend fun runRoutineNow(routineId: String): Result<SimpleSuccessResponse> {
        return execute("/api/ops/routines/$routineId/run", method = "POST")
    }

    suspend fun getSentinels(): Result<SentinelsResponse> {
        return execute("/api/ops/sentinels")
    }

    suspend fun toggleSentinel(sentinelId: String): Result<SimpleSuccessResponse> {
        return execute("/api/ops/sentinels/$sentinelId/toggle", method = "POST")
    }

    suspend fun runSentinelNow(sentinelId: String): Result<SimpleSuccessResponse> {
        return execute("/api/ops/sentinels/$sentinelId/run", method = "POST")
    }

    suspend fun getTraces(limit: Int = 50): Result<TracesResponse> {
        return execute("/api/ops/traces?limit=$limit")
    }

    suspend fun getCosts(): Result<CostsResponse> {
        return execute("/api/ops/costs")
    }

    // ==========================================
    // Spaces API
    // ==========================================

    suspend fun getSpaces(category: String? = null, search: String? = null): Result<SpacesResponse> {
        val params = mutableListOf<String>()
        if (!category.isNullOrBlank() && category != "All") {
            params.add("category=${category.lowercase()}")
        }
        if (!search.isNullOrBlank()) {
            params.add("search=${search.trim()}")
        }
        val query = if (params.isNotEmpty()) "?${params.joinToString("&")}" else ""
        return execute("/api/spaces$query")
    }

    suspend fun getSpace(slug: String): Result<SingleSpaceResponse> {
        return execute("/api/spaces/$slug")
    }

    suspend fun archiveSpace(slug: String): Result<SimpleSuccessResponse> {
        return execute("/api/spaces/$slug/archive", method = "POST")
    }

    suspend fun deleteSpace(slug: String): Result<SimpleSuccessResponse> {
        return execute("/api/spaces/$slug", method = "DELETE")
    }

    // ==========================================
    // Voice & Meeting Ingest API
    // ==========================================

    suspend fun getVoiceStatus(): Result<VoiceStatusResponse> {
        return execute("/api/voice/status")
    }

    suspend fun sendVoiceTurn(
        text: String? = null,
        audioBase64: String? = null,
        mimeType: String? = null,
        sessionId: String? = null,
        speakReply: Boolean = true,
        postToSlack: Boolean = false
    ): Result<VoiceTurnResponse> {
        val body = buildJsonObject {
            text?.let { put("text", it) }
            audioBase64?.let { put("audioBase64", it) }
            mimeType?.let { put("mimeType", it) }
            sessionId?.let { put("sessionId", it) }
            put("speakReply", speakReply)
            put("postToSlack", postToSlack)
        }.toString()
        return execute("/api/voice/turn", method = "POST", bodyJson = body)
    }

    suspend fun uploadMeeting(
        audioBase64: String? = null,
        mimeType: String? = null,
        transcript: String? = null,
        title: String? = null,
        durationSeconds: Int? = null,
        instructions: String? = null,
        postToSlack: Boolean = true
    ): Result<MeetingIngestResponse> {
        val body = buildJsonObject {
            audioBase64?.let { put("audioBase64", it) }
            mimeType?.let { put("mimeType", it) }
            transcript?.let { put("transcript", it) }
            title?.let { put("title", it) }
            durationSeconds?.let { put("durationSeconds", it) }
            instructions?.let { put("instructions", it) }
            put("postToSlack", postToSlack)
        }.toString()
        return execute("/api/voice/meeting", method = "POST", bodyJson = body)
    }
}
