package com.ellie.app.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ellie.app.data.EllieApiClient
import com.ellie.app.data.OpsStatusResponse
import com.ellie.app.data.ServerPreferences
import com.ellie.app.ui.components.StatusBadge
import com.ellie.app.ui.theme.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
    apiClient: EllieApiClient,
    serverPrefs: ServerPreferences,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var baseUrlInput by remember { mutableStateOf("") }
    var tokenInput by remember { mutableStateOf("") }
    var wakeWordEnabled by remember { mutableStateOf(true) }
    var speakReplies by remember { mutableStateOf(true) }

    var isTestingConnection by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf<String?>(null) }
    var opsStatus by remember { mutableStateOf<OpsStatusResponse?>(null) }
    var isSaving by remember { mutableStateOf(false) }

    fun refreshStatus() {
        scope.launch {
            val res = apiClient.getOpsStatus()
            res.onSuccess {
                opsStatus = it
                testResult = "Connected cleanly to Ellie control plane."
            }.onFailure {
                testResult = "Connection test failed: ${it.message}"
            }
        }
    }

    LaunchedEffect(Unit) {
        baseUrlInput = serverPrefs.baseUrl.first()
        tokenInput = serverPrefs.controlPlaneToken.first()
        wakeWordEnabled = serverPrefs.wakeWordEnabled.first()
        speakReplies = serverPrefs.speakReplies.first()
        refreshStatus()
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(DarkBg)
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Server Connection Config
        Surface(
            color = DarkSurface,
            shape = RoundedCornerShape(16.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, DarkPanelBorder),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(18.dp)) {
                Text(
                    text = "Server Connection",
                    color = TextPrimary,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = "Tailscale private IP (port 3001) or public HTTPS control plane URL.",
                    color = TextMuted,
                    fontSize = 12.sp
                )

                Spacer(Modifier.height(14.dp))

                OutlinedTextField(
                    value = baseUrlInput,
                    onValueChange = { baseUrlInput = it },
                    label = { Text("Base URL", color = TextSecondary) },
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary,
                        focusedBorderColor = AccentSky,
                        unfocusedBorderColor = DarkPanelBorder
                    ),
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(Modifier.height(10.dp))

                OutlinedTextField(
                    value = tokenInput,
                    onValueChange = { tokenInput = it },
                    label = { Text("Control Plane Token (Bearer)", color = TextSecondary) },
                    placeholder = { Text("Optional when on Tailscale private port", color = TextMuted) },
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary,
                        focusedBorderColor = AccentSky,
                        unfocusedBorderColor = DarkPanelBorder
                    ),
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(Modifier.height(16.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    OutlinedButton(
                        onClick = {
                            scope.launch {
                                isTestingConnection = true
                                testResult = null
                                refreshStatus()
                                isTestingConnection = false
                            }
                        },
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = AccentSky),
                        border = androidx.compose.foundation.BorderStroke(1.dp, AccentSkyDim)
                    ) {
                        Icon(Icons.Default.Sync, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(if (isTestingConnection) "Testing..." else "Test Connection", fontSize = 13.sp)
                    }

                    Button(
                        onClick = {
                            scope.launch {
                                isSaving = true
                                serverPrefs.saveBaseUrl(baseUrlInput)
                                serverPrefs.saveControlPlaneToken(tokenInput)
                                refreshStatus()
                                isSaving = false
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = AccentSkyDim)
                    ) {
                        Text(if (isSaving) "Saving..." else "Save Changes", color = TextPrimary)
                    }
                }

                testResult?.let { msg ->
                    Spacer(Modifier.height(12.dp))
                    Surface(
                        color = if (msg.contains("failed", ignoreCase = true)) StatusBad.copy(alpha = 0.15f) else StatusOk.copy(alpha = 0.15f),
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Row(modifier = Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                if (msg.contains("failed", ignoreCase = true)) Icons.Default.Error else Icons.Default.CheckCircle,
                                contentDescription = null,
                                tint = if (msg.contains("failed", ignoreCase = true)) StatusBad else StatusOk,
                                modifier = Modifier.size(18.dp)
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text = msg,
                                color = if (msg.contains("failed", ignoreCase = true)) StatusBad else StatusOk,
                                fontSize = 12.sp
                            )
                        }
                    }
                }
            }
        }

        // Live Governance & Integrations Status
        Surface(
            color = DarkSurface,
            shape = RoundedCornerShape(16.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, DarkPanelBorder),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(18.dp)) {
                Text(
                    text = "Live Integration Status",
                    color = TextPrimary,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = "Real-time health of Chief of Staff integrations and models.",
                    color = TextMuted,
                    fontSize = 12.sp
                )

                Spacer(Modifier.height(14.dp))

                // Google Workspace
                IntegrationRow(
                    name = "Google Workspace (Gmail / Calendar / Docs)",
                    isConnected = opsStatus?.googleConnected == true,
                    actionButton = {
                        OutlinedButton(
                            onClick = {
                                val url = "${baseUrlInput.trim().trimEnd('/')}/api/integrations/google/connect"
                                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                                context.startActivity(intent)
                            },
                            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                            border = androidx.compose.foundation.BorderStroke(1.dp, AccentSkyDim)
                        ) {
                            Icon(Icons.Default.OpenInBrowser, contentDescription = null, modifier = Modifier.size(14.dp), tint = AccentSky)
                            Spacer(Modifier.width(4.dp))
                            Text("Connect / Reauth", fontSize = 11.sp, color = AccentSky)
                        }
                    }
                )

                Divider(color = DarkPanelBorder, modifier = Modifier.padding(vertical = 10.dp))

                // Slack Bot
                IntegrationRow(
                    name = "Slack Coworker Bot",
                    isConnected = opsStatus?.slackConfigured == true
                )

                Divider(color = DarkPanelBorder, modifier = Modifier.padding(vertical = 10.dp))

                // Proton Mail Bridge
                IntegrationRow(
                    name = "Proton Mail Bridge",
                    isConnected = opsStatus?.protonConfigured == true
                )

                Divider(color = DarkPanelBorder, modifier = Modifier.padding(vertical = 10.dp))

                // Active Models
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column {
                        Text("Active Production Models", color = TextPrimary, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            text = "Default: ${opsStatus?.flashModel.orEmpty().ifBlank { "gemini-3.8-flash" }}",
                            color = AccentSky,
                            fontSize = 12.sp
                        )
                        Text(
                            text = "Reasoning: ${opsStatus?.reasoningModel.orEmpty().ifBlank { "gemini-3.8-flash" }}",
                            color = StatusWarn,
                            fontSize = 12.sp
                        )
                    }
                }
            }
        }

        // Voice & Assistant Preferences
        Surface(
            color = DarkSurface,
            shape = RoundedCornerShape(16.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, DarkPanelBorder),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(18.dp)) {
                Text(
                    text = "Voice & Wake Word Preferences",
                    color = TextPrimary,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.Bold
                )

                Spacer(Modifier.height(14.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Hands-Free 'Hey Ellie' Wake Word", color = TextPrimary, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                        Text("Runs on-device wake-phrase detection when enabled.", color = TextMuted, fontSize = 12.sp)
                    }
                    Switch(
                        checked = wakeWordEnabled,
                        onCheckedChange = { isEnabled ->
                            wakeWordEnabled = isEnabled
                            scope.launch {
                                serverPrefs.setWakeWordEnabled(isEnabled)
                                if (isEnabled) {
                                    com.ellie.app.service.EllieWakeWordService.start(context)
                                } else {
                                    com.ellie.app.service.EllieWakeWordService.stop(context)
                                }
                            }
                        },
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = TextPrimary,
                            checkedTrackColor = AccentSky,
                            uncheckedTrackColor = DarkPanel
                        )
                    )
                }

                Spacer(Modifier.height(12.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Speak Spoken Audio Replies", color = TextPrimary, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                        Text("Uses Gemini Flash Lite TTS to vocalize Ellie's responses.", color = TextMuted, fontSize = 12.sp)
                    }
                    Switch(
                        checked = speakReplies,
                        onCheckedChange = {
                            speakReplies = it
                            scope.launch { serverPrefs.setSpeakReplies(it) }
                        },
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = TextPrimary,
                            checkedTrackColor = AccentSky,
                            uncheckedTrackColor = DarkPanel
                        )
                    )
                }
            }
        }
    }
}

@Composable
fun IntegrationRow(
    name: String,
    isConnected: Boolean,
    actionButton: (@Composable () -> Unit)? = null
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(name, color = TextPrimary, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            StatusBadge(
                text = if (isConnected) "Connected" else "Not Configured",
                color = if (isConnected) StatusOk else StatusBad,
                modifier = Modifier.padding(top = 4.dp)
            )
        }
        actionButton?.invoke()
    }
}
