package com.ellie.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ellie.app.data.CostBreakdown
import com.ellie.app.data.CostSummary
import com.ellie.app.data.EllieApiClient
import com.ellie.app.data.TierCostMetrics
import com.ellie.app.ui.components.ErrorState
import com.ellie.app.ui.components.LoadingState
import com.ellie.app.ui.components.StatusBadge
import com.ellie.app.ui.theme.*
import kotlinx.coroutines.launch
import java.util.Locale

@Composable
fun CostsScreen(
    apiClient: EllieApiClient,
    modifier: Modifier = Modifier
) {
    val scope = rememberCoroutineScope()
    var isLoading by remember { mutableStateOf(true) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var summary by remember { mutableStateOf<CostSummary?>(null) }
    var breakdown by remember { mutableStateOf<CostBreakdown?>(null) }

    fun loadCosts() {
        scope.launch {
            isLoading = true
            errorMessage = null
            val res = apiClient.getCosts()
            res.onSuccess { data ->
                summary = data.summary
                breakdown = data.breakdown
                isLoading = false
            }.onFailure { err ->
                errorMessage = err.message ?: "Failed to load cost telemetry"
                isLoading = false
            }
        }
    }

    LaunchedEffect(Unit) {
        loadCosts()
    }

    Box(modifier = modifier.fillMaxSize().background(DarkBg)) {
        when {
            isLoading && summary == null -> {
                LoadingState()
            }
            errorMessage != null && summary == null -> {
                ErrorState(message = errorMessage ?: "Unknown error", onRetry = { loadCosts() })
            }
            summary != null -> {
                val totalCost = (breakdown?.flash?.estimatedCostUsd ?: 0.0) +
                        (breakdown?.reasoning?.estimatedCostUsd ?: 0.0)

                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    // Total Spend Overview Card
                    Surface(
                        color = DarkSurface,
                        shape = RoundedCornerShape(16.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkPanelBorder),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(20.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text("7-Day Spend & Usage", color = TextSecondary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                                StatusBadge(text = "Active Tiers", color = StatusOk)
                            }

                            Spacer(Modifier.height(8.dp))

                            Text(
                                text = String.format(Locale.US, "$%.4f USD", totalCost),
                                color = TextPrimary,
                                fontSize = 32.sp,
                                fontWeight = FontWeight.Bold
                            )

                            Spacer(Modifier.height(14.dp))

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Column {
                                    Text("Total Model Calls", color = TextMuted, fontSize = 12.sp)
                                    Text("${summary?.callsCount ?: 0}", color = TextPrimary, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                                }
                                Column {
                                    Text("Total Tokens Processed", color = TextMuted, fontSize = 12.sp)
                                    Text(
                                        formatTokens(summary?.totalTokens ?: 0),
                                        color = AccentSky,
                                        fontSize = 16.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }
                        }
                    }

                    // Gemini Flash Card
                    TierCard(
                        title = "Gemini Flash (Default Tier)",
                        subtitle = "Handles real-time conversation, sentinels, routines, and lightweight tools.",
                        metrics = breakdown?.flash,
                        accentColor = AccentSky
                    )

                    // Gemini Reasoning Card
                    TierCard(
                        title = "Reasoning Tier (Deep Analysis)",
                        subtitle = "Dedicated deep thinking and evaluation tier for complex synthesis and plans.",
                        metrics = breakdown?.reasoning,
                        accentColor = StatusWarn
                    )
                }
            }
        }
    }
}

@Composable
fun TierCard(
    title: String,
    subtitle: String,
    metrics: TierCostMetrics?,
    accentColor: androidx.compose.ui.graphics.Color
) {
    Surface(
        color = DarkSurface,
        shape = RoundedCornerShape(14.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, DarkPanelBorder),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(modifier = Modifier.padding(18.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(title, color = TextPrimary, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Text(
                    text = String.format(Locale.US, "$%.4f", metrics?.estimatedCostUsd ?: 0.0),
                    color = accentColor,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold
                )
            }

            Spacer(Modifier.height(4.dp))
            Text(subtitle, color = TextMuted, fontSize = 12.sp)

            Spacer(Modifier.height(16.dp))
            Divider(color = DarkPanelBorder)
            Spacer(Modifier.height(14.dp))

            MetricRow("Model Calls", "${metrics?.callsCount ?: 0}")
            MetricRow("Prompt Tokens", formatTokens(metrics?.promptTokens ?: 0))

            if ((metrics?.cachedTokens ?: 0) > 0) {
                val total = (metrics?.promptTokens ?: 0) + (metrics?.completionTokens ?: 0)
                val hitPct = if (total > 0) ((metrics?.cachedTokens ?: 0) * 100 / total) else 0
                MetricRow("Context Cache Hits", "${formatTokens(metrics?.cachedTokens ?: 0)} ($hitPct%)")
            }

            if ((metrics?.thinkingTokens ?: 0) > 0) {
                MetricRow("Thinking (Reasoning) Tokens", formatTokens(metrics?.thinkingTokens ?: 0))
            }

            MetricRow("Completion Tokens", formatTokens(metrics?.completionTokens ?: 0))
            MetricRow("Total Tier Tokens", formatTokens(metrics?.totalTokens ?: 0))
        }
    }
}

@Composable
fun MetricRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label, color = TextSecondary, fontSize = 13.sp)
        Text(value, color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}

private fun formatTokens(count: Long): String {
    return when {
        count >= 1_000_000 -> String.format(Locale.US, "%.2fM", count / 1_000_000.0)
        count >= 1_000 -> String.format(Locale.US, "%.1fk", count / 1_000.0)
        else -> count.toString()
    }
}
