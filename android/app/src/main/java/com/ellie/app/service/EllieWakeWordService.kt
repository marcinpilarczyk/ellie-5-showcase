package com.ellie.app.service

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.ellie.app.MainActivity
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

/**
 * Foreground service that runs continuous on-device energy/speech presence detection
 * to listen for "Hey Ellie", "Hi Ellie", or "Ok Ellie".
 *
 * Runs with foregroundServiceType="microphone".
 * When triggered, vibrates briefly and starts MainActivity with EXTRA_OPEN_VOICE_OVERLAY = true.
 * Automatically yields mic access when LiveVoiceOverlay or MeetingRecorderService is active.
 */
class EllieWakeWordService : Service() {

    companion object {
        const val CHANNEL_ID = "ellie_wake_word_channel"
        const val NOTIFICATION_ID = 2001

        const val ACTION_START = "com.ellie.app.action.START_WAKE_WORD"
        const val ACTION_STOP = "com.ellie.app.action.STOP_WAKE_WORD"

        const val EXTRA_OPEN_VOICE_OVERLAY = "EXTRA_OPEN_VOICE_OVERLAY"
        const val EXTRA_START_MEETING_RECORDER = "EXTRA_START_MEETING_RECORDER"

        // Global flag allowing LiveVoiceOverlay and MeetingRecorder to coordinate mic usage
        val isPausedByActiveSession = AtomicBoolean(false)
        val isServiceRunning = AtomicBoolean(false)

        fun hasMicPermission(context: Context): Boolean {
            return ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED
        }

        fun start(context: Context) {
            if (!hasMicPermission(context)) {
                return
            }
            val intent = Intent(context, EllieWakeWordService::class.java).apply {
                action = ACTION_START
            }
            try {
                context.startService(intent)
            } catch (_: Exception) {
                // Ignore if background start or FGS restriction prevents launch
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, EllieWakeWordService::class.java).apply {
                action = ACTION_STOP
            }
            try {
                context.startService(intent)
            } catch (_: Exception) {}
        }
    }

    private val serviceScope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private var listeningJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopWakeWordDetection()
                try {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                } catch (_: Exception) {}
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                if (!hasMicPermission(this)) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                if (!startForegroundWithNotification()) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                startWakeWordDetection()
                return START_STICKY
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopWakeWordDetection()
        serviceScope.cancel()
        isServiceRunning.set(false)
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Ellie Wake Word Service",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Monitors for 'Hey Ellie' wake word"
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun startForegroundWithNotification(): Boolean {
        val stopIntent = Intent(this, EllieWakeWordService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            0,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_OPEN_VOICE_OVERLAY, true)
        }
        val openAppPendingIntent = PendingIntent.getActivity(
            this,
            1,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Ellie Wake Word Active")
            .setContentText("Listening for 'Hey Ellie'...")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(openAppPendingIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            isServiceRunning.set(true)
            true
        } catch (e: Exception) {
            isServiceRunning.set(false)
            false
        }
    }

    private fun startWakeWordDetection() {
        if (listeningJob?.isActive == true) return

        listeningJob = serviceScope.launch {
            val sampleRate = 16000
            val channelConfig = AudioFormat.CHANNEL_IN_MONO
            val audioFormat = AudioFormat.ENCODING_PCM_16BIT
            val minBufSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
            val bufferSize = (minBufSize * 2).coerceAtLeast(4096)

            while (isActive) {
                // If paused because user is actively recording in LiveVoiceOverlay or MeetingRecorder, wait
                if (isPausedByActiveSession.get()) {
                    delay(500)
                    continue
                }

                var audioRecord: AudioRecord? = null
                try {
                    audioRecord = AudioRecord(
                        MediaRecorder.AudioSource.MIC,
                        sampleRate,
                        channelConfig,
                        audioFormat,
                        bufferSize
                    )

                    if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
                        delay(2000)
                        continue
                    }

                    audioRecord.startRecording()
                    val audioBuffer = ShortArray(bufferSize / 2)

                    // Track speech activity and ring buffer
                    var speechDetectedFrames = 0
                    val energyThreshold = 1800 // calibrated speech energy

                    val record = audioRecord
                    while (isActive && !isPausedByActiveSession.get() && record != null) {
                        val readCount = record.read(audioBuffer, 0, audioBuffer.size)
                        if (readCount > 0) {
                            var maxAmp = 0
                            var sumAmp = 0L
                            for (i in 0 until readCount) {
                                val absVal = abs(audioBuffer[i].toInt())
                                if (absVal > maxAmp) maxAmp = absVal
                                sumAmp += absVal
                            }
                            val avgAmp = sumAmp / readCount

                            if (maxAmp > energyThreshold) {
                                speechDetectedFrames++
                                // When speech detected continuously for ~0.6 sec, trigger speech recognition pass
                                if (speechDetectedFrames >= 6) {
                                    speechDetectedFrames = 0
                                    // Pause wake word audio record to let speech recognizer or voice turn execute
                                    record.stop()
                                    record.release()
                                    audioRecord = null

                                    performSpeechRecognitionCheck()
                                    break
                                }
                            } else {
                                if (speechDetectedFrames > 0) {
                                    speechDetectedFrames--
                                }
                            }
                        }
                        delay(50)
                    }
                } catch (e: SecurityException) {
                    delay(5000)
                } catch (e: Exception) {
                    delay(2000)
                } finally {
                    try {
                        audioRecord?.stop()
                        audioRecord?.release()
                    } catch (_: Exception) {}
                }
            }
        }
    }

    private suspend fun performSpeechRecognitionCheck() {
        withContext(Dispatchers.Main) {
            try {
                if (isPausedByActiveSession.get()) return@withContext

                val recognizer = android.speech.SpeechRecognizer.createSpeechRecognizer(this@EllieWakeWordService)
                val recognizerIntent = Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(android.speech.RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    putExtra(android.speech.RecognizerIntent.EXTRA_MAX_RESULTS, 3)
                    putExtra(android.speech.RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
                }

                val recognitionCompleted = CompletableDeferred<Unit>()

                recognizer.setRecognitionListener(object : android.speech.RecognitionListener {
                    override fun onReadyForSpeech(params: android.os.Bundle?) {}
                    override fun onBeginningOfSpeech() {}
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() {}
                    override fun onError(error: Int) {
                        try { recognizer.destroy() } catch (_: Exception) {}
                        if (!recognitionCompleted.isCompleted) recognitionCompleted.complete(Unit)
                    }

                    override fun onResults(results: android.os.Bundle?) {
                        val matches = results?.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION)
                        processMatches(matches)
                        try { recognizer.destroy() } catch (_: Exception) {}
                        if (!recognitionCompleted.isCompleted) recognitionCompleted.complete(Unit)
                    }

                    override fun onPartialResults(partialResults: android.os.Bundle?) {
                        val matches = partialResults?.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION)
                        if (processMatches(matches)) {
                            try { recognizer.cancel(); recognizer.destroy() } catch (_: Exception) {}
                            if (!recognitionCompleted.isCompleted) recognitionCompleted.complete(Unit)
                        }
                    }

                    override fun onEvent(eventType: Int, params: android.os.Bundle?) {}
                })

                recognizer.startListening(recognizerIntent)

                // Timeout after 4.5 seconds if speech recognizer is silent
                withTimeoutOrNull(4500) {
                    recognitionCompleted.await()
                }
                try {
                    recognizer.cancel()
                    recognizer.destroy()
                } catch (_: Exception) {}
            } catch (_: Exception) {}
        }
        delay(600)
    }

    private fun processMatches(matches: List<String>?): Boolean {
        if (matches == null) return false
        for (raw in matches) {
            val lower = raw.lowercase(Locale.ROOT).trim()

            // Meeting recording voice triggers
            if (lower.contains("record this meeting") || lower.contains("start recording meeting") ||
                lower.contains("record meeting") || lower.contains("start meeting recording")) {
                vibrateFeedback()
                MeetingRecorderService.startRecording(this, "Spoken Voice Meeting", "Started via 'Hey Ellie' voice trigger")
                return true
            }

            // Wake word triggers
            if (lower.contains("hey ellie") || lower.contains("hi ellie") || lower.contains("ok ellie") ||
                lower.startsWith("ellie ") || lower == "ellie") {
                vibrateFeedback()
                val openIntent = Intent(this, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                    putExtra(EXTRA_OPEN_VOICE_OVERLAY, true)
                }
                startActivity(openIntent)
                return true
            }
        }
        return false
    }

    private fun vibrateFeedback() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vibratorManager = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vibratorManager?.defaultVibrator?.vibrate(
                    VibrationEffect.createOneShot(120, VibrationEffect.DEFAULT_AMPLITUDE)
                )
            } else {
                @Suppress("DEPRECATION")
                val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator?.vibrate(VibrationEffect.createOneShot(120, VibrationEffect.DEFAULT_AMPLITUDE))
                } else {
                    @Suppress("DEPRECATION")
                    vibrator?.vibrate(120)
                }
            }
        } catch (_: Exception) {}
    }

    private fun stopWakeWordDetection() {
        listeningJob?.cancel()
        listeningJob = null
    }
}
