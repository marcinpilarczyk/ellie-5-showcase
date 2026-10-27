package com.ellie.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// ==========================================
// Generic API Responses
// ==========================================

@Serializable
data class SimpleSuccessResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val message: String? = null
)

// ==========================================
// 1. Approvals / Queue Models
// ==========================================

@Serializable
data class QueueResponse(
    val ok: Boolean = false,
    val count: Int = 0,
    val items: List<StagedActionItem> = emptyList(),
    val error: String? = null
)

@Serializable
data class StagedActionItem(
    val id: String,
    val actionType: String,
    val payload: JsonObject? = null,
    val state: String = "staged",
    val batchId: String? = null,
    val createdAt: String? = null,
    val expiresAt: String? = null,
    val slackChannel: String? = null,
    val slackThreadTs: String? = null
)

@Serializable
data class ActionOutcomeResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val executionResult: String? = null
)

// ==========================================
// 2. Routines & Sentinels Models
// ==========================================

@Serializable
data class RoutinesResponse(
    val ok: Boolean = false,
    val routines: List<RoutineItem> = emptyList(),
    val error: String? = null
)

@Serializable
data class RoutineItem(
    val id: String,
    val title: String,
    val description: String? = null,
    val cron_schedule: String,
    val cadence_description: String? = null,
    val timezone: String? = null,
    val destination: String? = "Slack",
    val is_active: Int = 1,
    val last_run_at: String? = null,
    val last_run_status: String? = null,
    val last_run_note: String? = null,
    val running_since: String? = null,
    val primary_model: String? = null
)

@Serializable
data class SentinelsResponse(
    val ok: Boolean = false,
    val sentinels: List<SentinelItem> = emptyList(),
    val error: String? = null
)

@Serializable
data class SentinelItem(
    val id: String,
    val name: String = "",
    val is_active: Int = 1,
    val last_check_at: String? = null,
    val last_status: String? = null,
    val last_report_json: String? = null
)

// ==========================================
// 3. Run Traces Models
// ==========================================

@Serializable
data class TracesResponse(
    val ok: Boolean = false,
    val count: Int = 0,
    val traces: List<RunTraceItem> = emptyList(),
    val error: String? = null
)

@Serializable
data class ToolCallTrace(
    val tool: String,
    val params: JsonObject? = null,
    val durationMs: Long = 0,
    val handle: String? = null
)

@Serializable
data class RunTraceItem(
    val id: Long? = null,
    val run_id: String,
    val trigger: String,
    val instruction: String,
    val status: String,
    val duration_ms: Long = 0,
    val model_ms: Long = 0,
    val total_tokens: Long = 0,
    val cached_tokens: Long = 0,
    val created_at: String? = null,
    val error: String? = null,
    val delivered_text: String? = null,
    val toolsCalled: List<ToolCallTrace> = emptyList(),
    val handlesUsed: List<String> = emptyList()
)

// ==========================================
// 4. Cost Telemetry Models
// ==========================================

@Serializable
data class CostsResponse(
    val ok: Boolean = false,
    val summary: CostSummary? = null,
    val breakdown: CostBreakdown? = null,
    val error: String? = null
)

@Serializable
data class CostSummary(
    val totalPromptTokens: Long = 0,
    val totalCompletionTokens: Long = 0,
    val totalTokens: Long = 0,
    val callsCount: Int = 0
)

@Serializable
data class CostBreakdown(
    val totalCostUsd: Double = 0.0,
    val flash: TierCostMetrics? = null,
    val reasoning: TierCostMetrics? = null
)

@Serializable
data class TierCostMetrics(
    val callsCount: Int = 0,
    val promptTokens: Long = 0,
    val cachedTokens: Long = 0,
    val thinkingTokens: Long = 0,
    val completionTokens: Long = 0,
    val totalTokens: Long = 0,
    val estimatedCostUsd: Double = 0.0
)

// ==========================================
// 5. Spaces Gallery Models
// ==========================================

@Serializable
data class SpacesResponse(
    val ok: Boolean = false,
    val count: Int = 0,
    val spaces: List<SpaceItem> = emptyList(),
    val error: String? = null
)

@Serializable
data class SpaceItem(
    val slug: String,
    val title: String,
    val description: String? = null,
    val category: String = "dashboards",
    val status: String = "active",
    val created_by: String = "owner",
    val trigger_type: String? = null,
    val created_at: String? = null,
    val updated_at: String? = null,
    val artifact_url: String? = null
)

@Serializable
data class SingleSpaceResponse(
    val ok: Boolean = false,
    val space: SpaceItem? = null,
    val content: String? = null,
    val error: String? = null
)

// ==========================================
// 6. Admin Ops & Integration Status Models
// ==========================================

@Serializable
data class OpsStatusResponse(
    val ok: Boolean = false,
    val googleConnected: Boolean = false,
    val slackConfigured: Boolean = false,
    val protonConfigured: Boolean = false,
    val claimsBankConfigured: Boolean = false,
    val flashModel: String = "",
    val reasoningModel: String = "",
    val activeRoutinesCount: Int = 0,
    val sentinelsCount: Int = 0,
    val stagedQueueCount: Int = 0,
    val timestamp: String? = null,
    val error: String? = null
)

// ==========================================
// 7. Voice & Meeting Ingest Models
// ==========================================

@Serializable
data class VoiceStatusResponse(
    val ok: Boolean = false,
    val flashModel: String = "",
    val reasoningModel: String = "",
    val transcribeModel: String = "",
    val ttsModel: String = "",
    val liveModel: String = "",
    val activeSessions: Int = 0,
    val error: String? = null
)

@Serializable
data class VoiceTurnResponse(
    val ok: Boolean = false,
    val sessionId: String? = null,
    val runId: String? = null,
    val transcript: String? = null,
    val replyText: String? = null,
    val finishStatus: String? = null,
    val artifactLink: String? = null,
    val stagedActionsCount: Int = 0,
    val audioBase64: String? = null,
    val audioMimeType: String? = null,
    val error: String? = null
)

@Serializable
data class MeetingIngestResponse(
    val ok: Boolean = false,
    val runId: String? = null,
    val title: String? = null,
    val transcript: String? = null,
    val summary: String? = null,
    val artifactLink: String? = null,
    val slackTs: String? = null,
    val error: String? = null
)
