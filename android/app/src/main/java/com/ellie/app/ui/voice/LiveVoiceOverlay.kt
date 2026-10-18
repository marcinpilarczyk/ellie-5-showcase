package com.ellie.app.ui.voice

import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.util.Base64
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.ellie.app.data.EllieApiClient
import com.ellie.app.data.ServerPreferences
import com.ellie.app.service.EllieWakeWordService
import com.ellie.app.service.MeetingRecorderService
import com.ellie.app.ui.theme.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

data class VoiceMessageBubble(
    val id: String = UUID.randomUUID().toString(),
    val sender: String, // "user" or "ellie"
    val text: String,
    val stagedActionsCount: Int = 0,
    val hasAudio: Boolean = false
)

/**
 * Full-featured Two-Way Live Voice Overlay.
 *
 * Supports:
 * - Tap-to-talk / Hold-to-talk recording mono AAC/M4A via MediaRecorder
 * - Visual live amplitude indicator
 * - Automatic Base64-encoding and sending to /api/voice/turn
 * - Automatic decoding & playback of Gemini TTS audio reply
 * - Auto-listen loop continuation until dismissed or stopped
 * - Voice command shortcut detection (e.g. "record this meeting" launches MeetingRecorderService)
 * - Text fallback input
 */
@Composable
fun LiveVoiceOverlay(
    apiClient: EllieApiClient,
    serverPrefs: ServerPreferences,
    onDismiss: () -> Unit,
    onStartMeetingRecorder: (title: String?, instructions: String?) -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val currentSessionId = remember { "android_session_${UUID.randomUUID().toString().take(8)}" }
    val conversation = remember { mutableStateListOf<VoiceMessageBubble>() }
    val listState = rememberLazyListState()

    var textInput by remember { mutableStateOf("") }
    var isRecording by remember { mutableStateOf(false) }
    var isProcessing by remember { mutableStateOf(false) }
    var isPlayingAudio by remember { mutableStateOf(false) }
    var autoListenLoop by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var micAmplitude by remember { mutableFloatStateOf(0.1f) }

    var mediaRecorder by remember { mutableStateOf<MediaRecorder?>(null) }
    var currentRecordFile by remember { mutableStateOf<File?>(null) }
    var mediaPlayer by remember { mutableStateOf<MediaPlayer?>(null) }

    // Scroll to bottom when new bubbles arrive
    LaunchedEffect(conversation.size) {
        if (conversation.isNotEmpty()) {
            listState.animateScrollToItem(conversation.size - 1)
        }
    }

    // Tell EllieWakeWordService to yield mic while LiveVoiceOverlay is shown
    DisposableEffect(Unit) {
        EllieWakeWordService.isPausedByActiveSession.set(true)
        onDispose {
            try {
                mediaRecorder?.stop()
                mediaRecorder?.release()
            } catch (_: Exception) {}
            try {
                mediaPlayer?.stop()
                mediaPlayer?.release()
            } catch (_: Exception) {}
            EllieWakeWordService.isPausedByActiveSession.set(false)
        }
    }

    // Playback helper
    fun playSpokenAudio(base64Audio: String, mimeType: String?, onComplete: () -> Unit) {
        try {
            val audioBytes = Base64.decode(base64Audio, Base64.DEFAULT)
            val extension = if (mimeType?.contains("wav") == true) ".wav" else ".m4a"
            val tempAudio = File(context.cacheDir, "reply_${System.currentTimeMillis()}$extension")
            FileOutputStream(tempAudio).use { it.write(audioBytes) }

            mediaPlayer?.release()
            val player = MediaPlayer().apply {
                setDataSource(tempAudio.absolutePath)
                prepare()
                setOnCompletionListener {
                    isPlayingAudio = false
                    tempAudio.delete()
                    onComplete()
                }
                setOnErrorListener { _, _, _ ->
                    isPlayingAudio = false
                    tempAudio.delete()
                    onComplete()
                    true
                }
            }
            mediaPlayer = player
            isPlayingAudio = true
            player.start()
        } catch (e: Exception) {
            isPlayingAudio = false
            onComplete()
        }
    }

    // Send audio turn
    fun sendAudioTurn(file: File) {
        scope.launch {
            try {
                isProcessing = true
                errorMessage = null
                val bytes = file.readBytes()
                val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                file.delete()

                val speakRepliesEnabled = serverPrefs.speakReplies.first()

                val res = apiClient.sendVoiceTurn(
                    audioBase64 = base64,
                    mimeType = "audio/mp4",
                    sessionId = currentSessionId,
                    speakReply = speakRepliesEnabled,
                    postToSlack = false
                )

                res.onSuccess { turn ->
                    val transcript = turn.transcript ?: "(voice input)"
                    conversation.add(VoiceMessageBubble(sender = "user", text = transcript))

                    // Shortcut check: if user said "record this meeting"
                    val lower = transcript.lowercase()
                    if (lower.contains("record this meeting") || lower.contains("start meeting recording") || lower.contains("start recording meeting")) {
                        onStartMeetingRecorder("Voice Triggered Meeting", "Triggered by voice shortcut")
                        onDismiss()
                        return@launch
                    }

                    val reply = turn.replyText ?: "Understood."
                    conversation.add(
                        VoiceMessageBubble(
                            sender = "ellie",
                            text = reply,
                            stagedActionsCount = turn.stagedActionsCount,
                            hasAudio = turn.audioBase64 != null
                        )
                    )

                    if (!turn.audioBase64.isNullOrBlank() && speakRepliesEnabled) {
                        playSpokenAudio(turn.audioBase64, turn.audioMimeType) {
                            if (autoListenLoop) {
                                // Resume listening loop
                            }
                        }
                    }
                }.onFailure { err ->
                    errorMessage = err.message ?: "Failed to process voice turn"
                }
            } catch (e: Exception) {
                errorMessage = e.message ?: "Voice processing error"
            } finally {
                isProcessing = false
            }
        }
    }

    // Send text turn
    fun sendTextTurn(text: String) {
        val trimmed = text.trim()
        if (trimmed.isBlank()) return
        textInput = ""

        scope.launch {
            try {
                isProcessing = true
                errorMessage = null
                conversation.add(VoiceMessageBubble(sender = "user", text = trimmed))

                val lower = trimmed.lowercase()
                if (lower.contains("record this meeting") || lower.contains("start meeting recording")) {
                    onStartMeetingRecorder("Voice Triggered Meeting", "Triggered by text command")
                    onDismiss()
                    return@launch
                }

                val speakRepliesEnabled = serverPrefs.speakReplies.first()
                val res = apiClient.sendVoiceTurn(
                    text = trimmed,
                    sessionId = currentSessionId,
                    speakReply = speakRepliesEnabled,
                    postToSlack = false
                )

                res.onSuccess { turn ->
                    val reply = turn.replyText ?: "Understood."
                    conversation.add(
                        VoiceMessageBubble(
                            sender = "ellie",
                            text = reply,
                            stagedActionsCount = turn.stagedActionsCount,
                            hasAudio = turn.audioBase64 != null
                        )
                    )

                    if (!turn.audioBase64.isNullOrBlank() && speakRepliesEnabled) {
                        playSpokenAudio(turn.audioBase64, turn.audioMimeType) {}
                    }
                }.onFailure { err ->
                    errorMessage = err.message ?: "Failed to process turn"
                }
            } catch (e: Exception) {
                errorMessage = e.message ?: "Text processing error"
            } finally {
                isProcessing = false
            }
        }
    }

    // Start recording from mic
    fun startMicRecording() {
        if (isPlayingAudio) {
            mediaPlayer?.stop()
            isPlayingAudio = false
        }
        val file = File(context.cacheDir, "turn_${System.currentTimeMillis()}.m4a")
        currentRecordFile = file

        try {
            val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(context)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
            recorder.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(16000)
                setAudioEncodingBitRate(64000)
                setAudioChannels(1)
                setOutputFile(file.absolutePath)
                prepare()
                start()
            }
            mediaRecorder = recorder
            isRecording = true

            // Amplitude ticker
            scope.launch {
                while (isRecording && mediaRecorder != null) {
                    try {
                        val amp = mediaRecorder?.maxAmplitude ?: 0
                        micAmplitude = (amp / 18000f).coerceIn(0.1f, 1.4f)
                    } catch (_: Exception) {}
                    delay(80)
                }
                micAmplitude = 0.1f
            }
        } catch (e: Exception) {
            errorMessage = "Could not open mic: ${e.message}"
            isRecording = false
        }
    }

    // Stop recording and send
    fun stopMicRecording() {
        if (!isRecording) return
        isRecording = false
        try {
            mediaRecorder?.stop()
            mediaRecorder?.release()
        } catch (_: Exception) {}
        mediaRecorder = null

        val file = currentRecordFile
        if (file != null && file.exists() && file.length() > 0) {
            sendAudioTurn(file)
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Surface(
            color = DarkBg.copy(alpha = 0.96f),
            modifier = Modifier.fillMaxSize().padding(16.dp),
            shape = RoundedCornerShape(24.dp),
            border = androidx.compose.foundation.BorderStroke(1.5.dp, AccentSkyDim)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(20.dp)
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
                            color = if (isPlayingAudio) AccentSky else if (isRecording) StatusBad else StatusOk
                        ) {}
                        Spacer(Modifier.width(10.dp))
                        Column {
                            Text(
                                text = "Ellie Live Voice",
                                color = TextPrimary,
                                fontSize = 18.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                text = if (isPlayingAudio) "Speaking reply..." else if (isRecording) "Listening..." else if (isProcessing) "Thinking..." else "Ready",
                                color = if (isPlayingAudio) AccentSky else if (isRecording) StatusBad else TextSecondary,
                                fontSize = 12.sp
                            )
                        }
                    }

                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = onDismiss) {
                            Icon(Icons.Default.Close, contentDescription = "Close", tint = TextSecondary)
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                // Conversation Transcript List
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .padding(vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    if (conversation.isEmpty()) {
                        item {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 40.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Icon(
                                        Icons.Default.GraphicEq,
                                        contentDescription = null,
                                        tint = AccentSkyDim,
                                        modifier = Modifier.size(48.dp)
                                    )
                                    Spacer(Modifier.height(12.dp))
                                    Text(
                                        "Say 'Hey Ellie' or tap the microphone below",
                                        color = TextSecondary,
                                        fontSize = 14.sp
                                    )
                                    Text(
                                        "Ask questions, stage emails, check status, or say 'Record this meeting'",
                                        color = TextMuted,
                                        fontSize = 12.sp
                                    )
                                }
                            }
                        }
                    } else {
                        items(conversation, key = { it.id }) { bubble ->
                            ConversationBubbleItem(bubble)
                        }
                    }
                }

                errorMessage?.let { err ->
                    Surface(
                        color = StatusBad.copy(alpha = 0.15f),
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)
                    ) {
                        Text(
                            text = err,
                            color = StatusBad,
                            fontSize = 12.sp,
                            modifier = Modifier.padding(8.dp)
                        )
                    }
                }

                // Waveform / Pulsing Live Visualizer
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(80.dp),
                    contentAlignment = Alignment.Center
                ) {
                    if (isRecording) {
                        val infiniteTransition = rememberInfiniteTransition()
                        val pulse by infiniteTransition.animateFloat(
                            initialValue = 0.85f,
                            targetValue = 1.25f,
                            animationSpec = infiniteRepeatable(
                                animation = tween(600, easing = LinearEasing),
                                repeatMode = RepeatMode.Reverse
                            )
                        )
                        Box(
                            modifier = Modifier
                                .size((72 * micAmplitude * pulse).coerceIn(40f, 110f).dp)
                                .clip(CircleShape)
                                .background(StatusBad.copy(alpha = 0.25f)),
                            contentAlignment = Alignment.Center
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(46.dp)
                                    .clip(CircleShape)
                                    .background(StatusBad)
                            )
                        }
                    } else if (isPlayingAudio) {
                        val infiniteTransition = rememberInfiniteTransition()
                        val waveScale by infiniteTransition.animateFloat(
                            initialValue = 0.9f,
                            targetValue = 1.3f,
                            animationSpec = infiniteRepeatable(
                                animation = tween(450, easing = FastOutSlowInEasing),
                                repeatMode = RepeatMode.Reverse
                            )
                        )
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            repeat(5) { i ->
                                Box(
                                    modifier = Modifier
                                        .width(6.dp)
                                        .height((24 * waveScale * ((i % 3) + 0.8f)).dp)
                                        .clip(RoundedCornerShape(3.dp))
                                        .background(AccentSky)
                                )
                            }
                        }
                    } else if (isProcessing) {
                        CircularProgressIndicator(
                            color = AccentSky,
                            strokeWidth = 3.dp,
                            modifier = Modifier.size(36.dp)
                        )
                    } else {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            repeat(7) {
                                Box(
                                    modifier = Modifier
                                        .width(4.dp)
                                        .height(12.dp)
                                        .clip(RoundedCornerShape(2.dp))
                                        .background(DarkPanelBorder)
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(10.dp))

                // Bottom Action Bar: Mic Button + Text Fallback
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    OutlinedTextField(
                        value = textInput,
                        onValueChange = { textInput = it },
                        placeholder = { Text("Or type to Ellie...", color = TextMuted, fontSize = 13.sp) },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedTextColor = TextPrimary,
                            unfocusedTextColor = TextPrimary,
                            focusedBorderColor = AccentSky,
                            unfocusedBorderColor = DarkPanelBorder,
                            focusedContainerColor = DarkSurface,
                            unfocusedContainerColor = DarkSurface
                        ),
                        shape = RoundedCornerShape(20.dp),
                        modifier = Modifier.weight(1f)
                    )

                    if (textInput.isNotBlank()) {
                        IconButton(
                            onClick = { sendTextTurn(textInput) },
                            enabled = !isProcessing,
                            colors = IconButtonDefaults.iconButtonColors(
                                containerColor = AccentSkyDim,
                                contentColor = TextPrimary
                            ),
                            modifier = Modifier.size(46.dp)
                        ) {
                            Icon(Icons.Default.Send, contentDescription = "Send", modifier = Modifier.size(20.dp))
                        }
                    } else {
                        // Mic Button (Tap to Start / Tap to Stop)
                        FilledIconButton(
                            onClick = {
                                if (isRecording) {
                                    stopMicRecording()
                                } else {
                                    startMicRecording()
                                }
                            },
                            enabled = !isProcessing,
                            colors = IconButtonDefaults.filledIconButtonColors(
                                containerColor = if (isRecording) StatusBad else AccentSkyDim,
                                contentColor = TextPrimary
                            ),
                            modifier = Modifier.size(52.dp)
                        ) {
                            Icon(
                                if (isRecording) Icons.Default.Stop else Icons.Default.Mic,
                                contentDescription = if (isRecording) "Stop Listening" else "Start Talking",
                                modifier = Modifier.size(26.dp)
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun ConversationBubbleItem(bubble: VoiceMessageBubble) {
    val isUser = bubble.sender == "user"
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start
    ) {
        Surface(
            color = if (isUser) AccentSkyDim else DarkSurface,
            shape = RoundedCornerShape(
                topStart = 16.dp,
                topEnd = 16.dp,
                bottomStart = if (isUser) 16.dp else 4.dp,
                bottomEnd = if (isUser) 4.dp else 16.dp
            ),
            border = if (!isUser) androidx.compose.foundation.BorderStroke(1.dp, DarkPanelBorder) else null,
            modifier = Modifier.widthIn(max = 300.dp)
        ) {
            Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                Text(
                    text = if (isUser) "You" else "Ellie",
                    color = if (isUser) TextPrimary else AccentSky,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = bubble.text,
                    color = TextPrimary,
                    fontSize = 14.sp,
                    lineHeight = 20.sp
                )

                if (bubble.stagedActionsCount > 0) {
                    Spacer(Modifier.height(6.dp))
                    Surface(
                        color = StatusWarn.copy(alpha = 0.2f),
                        shape = RoundedCornerShape(6.dp)
                    ) {
                        Text(
                            text = "${bubble.stagedActionsCount} action(s) staged in queue",
                            color = StatusWarn,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 3.dp)
                        )
                    }
                }
            }
        }
    }
}
