package com.ellie.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ellie.app.data.EllieApiClient
import com.ellie.app.data.RunTraceItem
import com.ellie.app.ui.components.EmptyPlaceholder
import com.ellie.app.ui.components.ErrorState
import com.ellie.app.ui.components.LoadingState
import com.ellie.app.ui.components.StatusBadge
import com.ellie.app.ui.theme.*
import kotlinx.coroutines.launch

@Composable
fun RunsScreen(
    apiClient: EllieApiClient,
    modifier: Modifier = Modifier
) {
    val scope = rememberCoroutineScope()
    var isLoading by remember { mutableStateOf(true) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var traces by remember { mutableStateOf<List<RunTraceItem>>(emptyList()) }

    fun loadTraces() {
        scope.launch {
            isLoading = true
            errorMessage = null
            val res = apiClient.getTraces(50)
            res.onSuccess { data ->
                traces = data.traces
                isLoading = false
            }.onFailure { err ->
                errorMessage = err.message ?: "Failed to load run traces"
                isLoading = false
            }
        }
    }

    LaunchedEffect(Unit) {
        loadTraces()
    }

    Box(modifier = modifier.fillMaxSize().background(DarkBg)) {
        when {
            isLoading && traces.isEmpty() -> {
                LoadingState()
            }
            errorMessage != null && traces.isEmpty() -> {
                ErrorState(message = errorMessage ?: "Unknown error", onRetry = { loadTraces() })
            }
            traces.isEmpty() -> {
                EmptyPlaceholder(
                    title = "No Run Traces Recorded",
                    subtitle = "Traces from Slack, Voice, and Routines will appear here."
                )
            }
            else -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    items(traces, key = { it.run_id }) { trace ->
                        RunTraceCard(trace = trace)
                    }
                }
            }
        }
    }
}

@Composable
fun RunTraceCard(trace: RunTraceItem) {
    var isExpanded by remember { mutableStateOf(false) }

    Surface(
        color = DarkSurface,
        shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, DarkPanelBorder),
        modifier = Modifier.fillMaxWidth().clickable { isExpanded = !isExpanded }
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusBadge(
                        text = trace.status,
                        color = when (trace.status) {
                            "COMPLETED", "DONE" -> StatusOk
                            "FAILED" -> StatusBad
                            "TIMEOUT" -> StatusWarn
                            else -> AccentSky
                        }
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = trace.trigger.uppercase(),
                        color = TextMuted,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold
                    )
                }

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "${trace.duration_ms}ms",
                        color = TextSecondary,
                        fontSize = 12.sp
                    )
                    Icon(
                        if (isExpanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                        contentDescription = null,
                        tint = TextSecondary,
                        modifier = Modifier.size(20.dp)
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            Text(
                text = trace.instruction.take(160) + if (trace.instruction.length > 160) "..." else "",
                color = TextPrimary,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium
            )

            Spacer(modifier = Modifier.height(6.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    text = "${trace.total_tokens} tokens",
                    color = AccentSky,
                    fontSize = 12.sp
                )
                if (trace.cached_tokens > 0) {
                    val hitPct = if (trace.total_tokens > 0) (trace.cached_tokens * 100 / trace.total_tokens) else 0
                    Text(
                        text = "$hitPct% cached",
                        color = StatusOk,
                        fontSize = 12.sp
                    )
                }
                Text(
                    text = "${trace.toolsCalled.size} tool calls",
                    color = TextMuted,
                    fontSize = 12.sp
                )
            }

            AnimatedVisibility(visible = isExpanded) {
                Column(modifier = Modifier.padding(top = 14.dp)) {
                    Divider(color = DarkPanelBorder)
                    Spacer(modifier = Modifier.height(10.dp))

                    Text(
                        text = "Run ID: ${trace.run_id}",
                        color = TextMuted,
                        fontSize = 11.sp
                    )

                    trace.delivered_text?.let { msg ->
                        Spacer(modifier = Modifier.height(8.dp))
                        Text("Delivered to Slack:", color = AccentSky, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        Surface(
                            color = DarkPanel,
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.fillMaxWidth().padding(top = 4.dp)
                        ) {
                            Text(
                                text = msg,
                                color = TextPrimary,
                                fontSize = 13.sp,
                                modifier = Modifier.padding(10.dp)
                            )
                        }
                    }

                    trace.error?.let { err ->
                        Spacer(modifier = Modifier.height(8.dp))
                        Text("Error Output:", color = StatusBad, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        Surface(
                            color = StatusBad.copy(alpha = 0.15f),
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.fillMaxWidth().padding(top = 4.dp)
                        ) {
                            Text(
                                text = err,
                                color = StatusBad,
                                fontSize = 12.sp,
                                modifier = Modifier.padding(10.dp)
                            )
                        }
                    }

                    if (trace.toolsCalled.isNotEmpty()) {
                        Spacer(modifier = Modifier.height(10.dp))
                        Text("Tool Calls Executed:", color = TextSecondary, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        Spacer(modifier = Modifier.height(6.dp))

                        trace.toolsCalled.forEachIndexed { idx, toolCall ->
                            Surface(
                                color = DarkPanel,
                                shape = RoundedCornerShape(6.dp),
                                modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp)
                            ) {
                                Row(
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = "${idx + 1}. ${toolCall.tool}",
                                        color = TextPrimary,
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.Medium
                                    )
                                    Text(
                                        text = "${toolCall.durationMs}ms",
                                        color = TextMuted,
                                        fontSize = 11.sp
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
