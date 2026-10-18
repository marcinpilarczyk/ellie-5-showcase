package com.ellie.app.ui.voice

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.ellie.app.service.MeetingRecordState
import com.ellie.app.service.MeetingRecorderService
import com.ellie.app.ui.theme.*
import java.util.Locale

/**
 * Dialog for starting and monitoring triggered background meeting recordings.
 * Allows entering meeting title and owner focus instructions, shows elapsed time,
 * and displays resulting summary once processed.
 */
@Composable
fun MeetingRecorderDialog(
    initialTitle: String? = null,
    initialInstructions: String? = null,
    onDismiss: () -> Unit
) {
    val context = LocalContext.current
    val recordState by MeetingRecorderService.recordingState.collectAsState()

    var titleInput by remember { mutableStateOf(initialTitle ?: "") }
    var instructionsInput by remember { mutableStateOf(initialInstructions ?: "") }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Surface(
            color = DarkBg,
            shape = RoundedCornerShape(20.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, DarkPanelBorder),
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(22.dp)
            ) {
                // Header
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Surface(
                            modifier = Modifier.size(12.dp),
                            shape = CircleShape,
                            color = when (recordState) {
                                is MeetingRecordState.Recording -> StatusBad
                                is MeetingRecordState.Uploading -> StatusWarn
                                is MeetingRecordState.Completed -> StatusOk
                                else -> TextSecondary
                            }
                        ) {}
                        Spacer(Modifier.width(10.dp))
                        Text(
                            text = "Meeting & Voice Note Recorder",
                            color = TextPrimary,
                            fontSize = 17.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }

                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = TextSecondary)
                    }
                }

                Spacer(Modifier.height(14.dp))

                when (val state = recordState) {
                    is MeetingRecordState.Recording -> {
                        Surface(
                            color = DarkSurface,
                            shape = RoundedCornerShape(12.dp),
                            border = androidx.compose.foundation.BorderStroke(1.dp, StatusBad.copy(alpha = 0.5f)),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Column(
                                modifier = Modifier.padding(18.dp),
                                horizontalAlignment = Alignment.CenterHorizontally
                            ) {
                                Text(
                                    text = "RECORDING IN BACKGROUND",
                                    color = StatusBad,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold
                                )

                                Spacer(Modifier.height(8.dp))

                                val mm = state.elapsedSeconds / 60
                                val ss = state.elapsedSeconds % 60
                                val timeFormatted = String.format(Locale.ROOT, "%02d:%02d", mm, ss)

                                Text(
                                    text = timeFormatted,
                                    color = TextPrimary,
                                    fontSize = 40.sp,
                                    fontWeight = FontWeight.Bold
                                )

                                Text(
                                    text = "Meeting: ${state.title}",
                                    color = TextSecondary,
                                    fontSize = 13.sp
                                )

                                Spacer(Modifier.height(16.dp))

                                Button(
                                    onClick = {
                                        MeetingRecorderService.stopAndProcess(context)
                                    },
                                    colors = ButtonDefaults.buttonColors(containerColor = StatusBad),
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Icon(Icons.Default.Stop, contentDescription = null, modifier = Modifier.size(18.dp))
                                    Spacer(Modifier.width(8.dp))
                                    Text("Stop & Send to Ellie for Synthesis", color = TextPrimary, fontWeight = FontWeight.Bold)
                                }
                            }
                        }
                    }

                    is MeetingRecordState.Uploading -> {
                        Surface(
                            color = DarkSurface,
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Column(
                                modifier = Modifier.padding(24.dp),
                                horizontalAlignment = Alignment.CenterHorizontally
                            ) {
                                CircularProgressIndicator(color = AccentSky, modifier = Modifier.size(42.dp))
                                Spacer(Modifier.height(14.dp))
                                Text(
                                    text = "Synthesizing Meeting Notes...",
                                    color = TextPrimary,
                                    fontSize = 15.sp,
                                    fontWeight = FontWeight.SemiBold
                                )
                                Text(
                                    text = "Ellie is transcribing audio and structuring action items.",
                                    color = TextSecondary,
                                    fontSize = 12.sp
                                )
                            }
                        }
                    }

                    is MeetingRecordState.Completed -> {
                        Surface(
                            color = DarkSurface,
                            shape = RoundedCornerShape(12.dp),
                            border = androidx.compose.foundation.BorderStroke(1.dp, StatusOk.copy(alpha = 0.5f)),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Column(modifier = Modifier.padding(16.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Default.CheckCircle, contentDescription = null, tint = StatusOk)
                                    Spacer(Modifier.width(8.dp))
                                    Text("Meeting Synthesized Cleanly", color = StatusOk, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                                }

                                state.slackTs?.let {
                                    Spacer(Modifier.height(4.dp))
                                    Text("Posted to Slack executive briefing channel.", color = TextMuted, fontSize = 12.sp)
                                }

                                Spacer(Modifier.height(12.dp))

                                Text(
                                    text = state.summary ?: "No summary returned.",
                                    color = TextPrimary,
                                    fontSize = 13.sp,
                                    lineHeight = 19.sp
                                )

                                Spacer(Modifier.height(16.dp))

                                OutlinedButton(
                                    onClick = {
                                        // Reset to start a new recording
                                    },
                                    colors = ButtonDefaults.outlinedButtonColors(contentColor = AccentSky),
                                    border = androidx.compose.foundation.BorderStroke(1.dp, AccentSkyDim),
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Text("Done")
                                }
                            }
                        }
                    }

                    is MeetingRecordState.Error -> {
                        Surface(
                            color = StatusBad.copy(alpha = 0.15f),
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp)
                        ) {
                            Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Default.Error, contentDescription = null, tint = StatusBad)
                                Spacer(Modifier.width(8.dp))
                                Text(text = state.message, color = StatusBad, fontSize = 13.sp)
                            }
                        }
                    }

                    is MeetingRecordState.Idle -> {
                        Column {
                            Text(
                                text = "Record in Background",
                                color = TextPrimary,
                                fontSize = 14.sp,
                                fontWeight = FontWeight.SemiBold
                            )
                            Text(
                                text = "Recording runs in foreground service (with notification) even if screen is locked. Audio is compressed mono AAC and processed by Gemini Flash upon completion.",
                                color = TextMuted,
                                fontSize = 12.sp
                            )

                            Spacer(Modifier.height(14.dp))

                            OutlinedTextField(
                                value = titleInput,
                                onValueChange = { titleInput = it },
                                label = { Text("Meeting Title (Optional)", color = TextSecondary) },
                                placeholder = { Text("e.g. Q4 Executive Budget Review", color = TextMuted) },
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
                                value = instructionsInput,
                                onValueChange = { instructionsInput = it },
                                label = { Text("Owner Focus Instructions (Optional)", color = TextSecondary) },
                                placeholder = { Text("e.g. Focus on budget numbers and follow-ups to Alex", color = TextMuted) },
                                minLines = 2,
                                maxLines = 3,
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedTextColor = TextPrimary,
                                    unfocusedTextColor = TextPrimary,
                                    focusedBorderColor = AccentSky,
                                    unfocusedBorderColor = DarkPanelBorder
                                ),
                                modifier = Modifier.fillMaxWidth()
                            )

                            Spacer(Modifier.height(18.dp))

                            Button(
                                onClick = {
                                    val title = titleInput.ifBlank { "Meeting ${System.currentTimeMillis()}" }
                                    MeetingRecorderService.startRecording(
                                        context,
                                        title = title,
                                        instructions = instructionsInput.ifBlank { null }
                                    )
                                },
                                colors = ButtonDefaults.buttonColors(containerColor = AccentSkyDim),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Icon(Icons.Default.FiberManualRecord, contentDescription = null, modifier = Modifier.size(18.dp), tint = StatusBad)
                                Spacer(Modifier.width(8.dp))
                                Text("Start Background Recording", color = TextPrimary, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
            }
        }
    }
}
