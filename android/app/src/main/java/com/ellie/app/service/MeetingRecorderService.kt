package com.ellie.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.util.Base64
import androidx.core.app.NotificationCompat
import com.ellie.app.EllieApp
import com.ellie.app.MainActivity
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

sealed class MeetingRecordState {
    object Idle : MeetingRecordState()
    data class Recording(val elapsedSeconds: Int, val filePath: String, val title: String) : MeetingRecordState()
    data class Uploading(val title: String) : MeetingRecordState()
    data class Completed(val summary: String?, val slackTs: String?, val title: String?) : MeetingRecordState()
    data class Error(val message: String) : MeetingRecordState()
}

/**
 * Foreground Service that records background audio (mono AAC/M4A, 16kHz, 64kbps),
 * shows an ongoing notification with elapsed time MM:SS and a "Stop & Process" action,
 * and Base64-encodes and uploads the audio to Ellie's meeting endpoint on stop.
 */
class MeetingRecorderService : Service() {

    companion object {
        const val CHANNEL_ID = "ellie_meeting_channel"
        const val NOTIFICATION_ID = 3001

        const val ACTION_START_RECORDING = "com.ellie.app.action.START_MEETING_RECORD"
        const val ACTION_STOP_AND_PROCESS = "com.ellie.app.action.STOP_AND_PROCESS"

        const val EXTRA_MEETING_TITLE = "EXTRA_MEETING_TITLE"
        const val EXTRA_MEETING_INSTRUCTIONS = "EXTRA_MEETING_INSTRUCTIONS"

        private val _recordingState = MutableStateFlow<MeetingRecordState>(MeetingRecordState.Idle)
        val recordingState: StateFlow<MeetingRecordState> = _recordingState.asStateFlow()

        val isRecordingNow: Boolean
            get() = _recordingState.value is MeetingRecordState.Recording

        fun startRecording(context: Context, title: String? = null, instructions: String? = null) {
            if (!EllieWakeWordService.hasMicPermission(context)) {
                _recordingState.value = MeetingRecordState.Error("Microphone permission is required. Please grant microphone access first.")
                return
            }
            val intent = Intent(context, MeetingRecorderService::class.java).apply {
                action = ACTION_START_RECORDING
                putExtra(EXTRA_MEETING_TITLE, title)
                putExtra(EXTRA_MEETING_INSTRUCTIONS, instructions)
            }
            try {
                context.startService(intent)
            } catch (e: Exception) {
                _recordingState.value = MeetingRecordState.Error("Could not start recording service: ${e.message}")
            }
        }

        fun stopAndProcess(context: Context) {
            val intent = Intent(context, MeetingRecorderService::class.java).apply {
                action = ACTION_STOP_AND_PROCESS
            }
            context.startService(intent)
        }
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var mediaRecorder: MediaRecorder? = null
    private var currentOutputFile: File? = null
    private var timerJob: Job? = null
    private var elapsedSeconds = 0
    private var meetingTitle: String = "Recorded Meeting"
    private var meetingInstructions: String? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP_AND_PROCESS -> {
                handleStopAndProcess()
                return START_NOT_STICKY
            }
            ACTION_START_RECORDING -> {
                val title = intent.getStringExtra(EXTRA_MEETING_TITLE) ?: "Meeting ${System.currentTimeMillis()}"
                val instructions = intent.getStringExtra(EXTRA_MEETING_INSTRUCTIONS)
                startRecordingSession(title, instructions)
                return START_STICKY
            }
            else -> {
                if (mediaRecorder == null) {
                    stopSelf()
                }
                return START_NOT_STICKY
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopMediaRecordingSafely()
        timerJob?.cancel()
        serviceScope.cancel()
        EllieWakeWordService.isPausedByActiveSession.set(false)
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Ellie Meeting Recorder",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows live status and controls for meeting recording"
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun startRecordingSession(title: String, instructions: String?) {
        if (!EllieWakeWordService.hasMicPermission(this)) {
            _recordingState.value = MeetingRecordState.Error("Microphone permission is required.")
            stopSelf()
            return
        }

        // Signal WakeWord service to yield mic
        EllieWakeWordService.isPausedByActiveSession.set(true)

        meetingTitle = title
        meetingInstructions = instructions
        elapsedSeconds = 0

        if (!startForegroundNotification()) {
            EllieWakeWordService.isPausedByActiveSession.set(false)
            _recordingState.value = MeetingRecordState.Error("Could not start foreground microphone service.")
            stopSelf()
            return
        }

        val file = File(cacheDir, "meeting_${System.currentTimeMillis()}.m4a")
        currentOutputFile = file

        try {
            val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(this)
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
                setAudioChannels(1) // Mono
                setOutputFile(file.absolutePath)
                prepare()
                start()
            }
            mediaRecorder = recorder
            _recordingState.value = MeetingRecordState.Recording(0, file.absolutePath, meetingTitle)

            startTimer()
        } catch (e: Exception) {
            EllieWakeWordService.isPausedByActiveSession.set(false)
            _recordingState.value = MeetingRecordState.Error("Failed to initialize audio recorder: ${e.message}")
            try {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } catch (_: Exception) {}
            stopSelf()
        }
    }

    private fun startForegroundNotification(): Boolean {
        return try {
            val notification = buildNotification(0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun buildNotification(seconds: Int): Notification {
        val stopIntent = Intent(this, MeetingRecorderService::class.java).apply {
            action = ACTION_STOP_AND_PROCESS
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            0,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val openAppPendingIntent = PendingIntent.getActivity(
            this,
            1,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val mm = seconds / 60
        val ss = seconds % 60
        val timeFormatted = String.format(Locale.ROOT, "%02d:%02d", mm, ss)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Recording Meeting: $meetingTitle")
            .setContentText("Elapsed: $timeFormatted — Tap 'Stop & Process' when finished")
            .setSmallIcon(android.R.drawable.presence_audio_online)
            .setContentIntent(openAppPendingIntent)
            .addAction(android.R.drawable.ic_media_pause, "Stop & Process", stopPendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun startTimer() {
        timerJob?.cancel()
        timerJob = serviceScope.launch {
            val notificationManager = getSystemService(NotificationManager::class.java)
            while (isActive && mediaRecorder != null) {
                delay(1000)
                elapsedSeconds++
                val curFile = currentOutputFile
                if (curFile != null) {
                    _recordingState.value = MeetingRecordState.Recording(elapsedSeconds, curFile.absolutePath, meetingTitle)
                }
                notificationManager?.notify(NOTIFICATION_ID, buildNotification(elapsedSeconds))
            }
        }
    }

    private fun handleStopAndProcess() {
        timerJob?.cancel()
        timerJob = null

        val finalDuration = elapsedSeconds
        val recordedFile = currentOutputFile

        stopMediaRecordingSafely()
        EllieWakeWordService.isPausedByActiveSession.set(false)

        if (recordedFile == null || !recordedFile.exists() || recordedFile.length() == 0L) {
            _recordingState.value = MeetingRecordState.Error("No audio recorded or file was empty.")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }

        _recordingState.value = MeetingRecordState.Uploading(meetingTitle)

        // Upload in background coroutine
        serviceScope.launch {
            try {
                val bytes = recordedFile.readBytes()
                val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                val app = applicationContext as? EllieApp
                val apiClient = app?.apiClient

                if (apiClient == null) {
                    _recordingState.value = MeetingRecordState.Error("API client not available")
                    return@launch
                }

                val result = apiClient.uploadMeeting(
                    audioBase64 = base64,
                    mimeType = "audio/mp4",
                    title = meetingTitle,
                    durationSeconds = finalDuration,
                    instructions = meetingInstructions,
                    postToSlack = true
                )

                result.onSuccess { resp ->
                    _recordingState.value = MeetingRecordState.Completed(
                        summary = resp.summary,
                        slackTs = resp.slackTs,
                        title = resp.title ?: meetingTitle
                    )
                }.onFailure { err ->
                    _recordingState.value = MeetingRecordState.Error("Upload failed: ${err.message}")
                }
            } catch (e: Exception) {
                _recordingState.value = MeetingRecordState.Error("Failed processing recording: ${e.message}")
            } finally {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
    }

    private fun stopMediaRecordingSafely() {
        try {
            mediaRecorder?.stop()
        } catch (_: Exception) {}
        try {
            mediaRecorder?.release()
        } catch (_: Exception) {}
        mediaRecorder = null
    }
}
