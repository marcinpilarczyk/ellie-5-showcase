package com.ellie.app

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color as AndroidColor
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.ellie.app.data.EllieApiClient
import com.ellie.app.data.ServerPreferences
import com.ellie.app.service.EllieWakeWordService
import com.ellie.app.service.MeetingRecorderService
import com.ellie.app.ui.navigation.Screen
import com.ellie.app.ui.screens.*
import com.ellie.app.ui.theme.*
import com.ellie.app.ui.voice.LiveVoiceOverlay
import com.ellie.app.ui.voice.MeetingRecorderDialog
import kotlinx.coroutines.delay
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

class MainActivity : ComponentActivity() {

    private val openVoiceOverlayState = mutableStateOf(false)
    private val openMeetingDialogState = mutableStateOf(false)
    private var meetingTitleInit: String? = null
    private var meetingInstructionsInit: String? = null

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ -> }

    private fun requestMicAndNotificationPermissions() {
        try {
            val needed = mutableListOf<String>()
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.RECORD_AUDIO)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                needed.add(Manifest.permission.POST_NOTIFICATIONS)
            }
            if (needed.isNotEmpty()) {
                permissionLauncher.launch(needed.toTypedArray())
            }
        } catch (_: Exception) {}
    }

    private fun showNativeCrashScreen(crashText: String, onContinue: () -> Unit) {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(AndroidColor.parseColor("#090D16"))
            setPadding(48, 96, 48, 48)
        }

        val titleView = TextView(this).apply {
            text = "Ellie Diagnostic Crash Log"
            textSize = 20f
            setTextColor(AndroidColor.parseColor("#F87171"))
        }
        root.addView(titleView)

        val buttonRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.START
            setPadding(0, 24, 0, 24)
        }

        val copyBtn = Button(this).apply {
            text = "Copy Error"
            setOnClickListener {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                cm?.setPrimaryClip(ClipData.newPlainText("Ellie Crash", crashText))
                Toast.makeText(this@MainActivity, "Copied crash log", Toast.LENGTH_SHORT).show()
            }
        }
        buttonRow.addView(copyBtn)

        val continueBtn = Button(this).apply {
            text = "Clear & Open App"
            setOnClickListener {
                onContinue()
            }
        }
        buttonRow.addView(continueBtn)
        root.addView(buttonRow)

        val scroll = ScrollView(this)
        val bodyView = TextView(this).apply {
            text = crashText
            textSize = 12f
            setTextColor(AndroidColor.parseColor("#F1F5F9"))
            setTextIsSelectable(true)
        }
        scroll.addView(bodyView)
        root.addView(
            scroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        )

        setContentView(root)
    }

    private fun launchMainComposeUi() {
        try {
            val app = application as EllieApp
            val apiClient = app.apiClient
            val serverPreferences = app.serverPreferences

            handleLaunchIntent(intent)

            setContent {
                EllieTheme {
                    MainAppScaffold(
                        apiClient = apiClient,
                        serverPreferences = serverPreferences,
                        showVoiceOverlay = openVoiceOverlayState.value,
                        onDismissVoiceOverlay = { openVoiceOverlayState.value = false },
                        onOpenVoiceOverlay = {
                            requestMicAndNotificationPermissions()
                            openVoiceOverlayState.value = true
                        },
                        showMeetingDialog = openMeetingDialogState.value,
                        onDismissMeetingDialog = { openMeetingDialogState.value = false },
                        onOpenMeetingDialog = { title, instructions ->
                            requestMicAndNotificationPermissions()
                            meetingTitleInit = title
                            meetingInstructionsInit = instructions
                            openMeetingDialogState.value = true
                        },
                        meetingTitleInit = meetingTitleInit,
                        meetingInstructionsInit = meetingInstructionsInit
                    )
                }
            }
        } catch (t: Throwable) {
            val sw = StringWriter()
            t.printStackTrace(PrintWriter(sw))
            showNativeCrashScreen("Startup Exception:\n$sw") {}
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val crashFile = File(filesDir, "last_crash.txt")
        if (crashFile.exists()) {
            val text = runCatching { crashFile.readText() }.getOrDefault("Unknown crash")
            runCatching { crashFile.delete() }
            showNativeCrashScreen(text) {
                launchMainComposeUi()
            }
            return
        }

        launchMainComposeUi()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLaunchIntent(intent)
    }

    private fun handleLaunchIntent(intent: Intent?) {
        if (intent == null) return
        if (intent.getBooleanExtra(EllieWakeWordService.EXTRA_OPEN_VOICE_OVERLAY, false)) {
            openVoiceOverlayState.value = true
        }
        if (intent.getBooleanExtra(EllieWakeWordService.EXTRA_START_MEETING_RECORDER, false)) {
            openMeetingDialogState.value = true
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainAppScaffold(
    apiClient: EllieApiClient,
    serverPreferences: ServerPreferences,
    showVoiceOverlay: Boolean,
    onDismissVoiceOverlay: () -> Unit,
    onOpenVoiceOverlay: () -> Unit,
    showMeetingDialog: Boolean,
    onDismissMeetingDialog: () -> Unit,
    onOpenMeetingDialog: (title: String?, instructions: String?) -> Unit,
    meetingTitleInit: String?,
    meetingInstructionsInit: String?
) {
    var currentScreen by remember { mutableStateOf<Screen>(Screen.Approvals) }
    var stagedCount by remember { mutableIntStateOf(0) }
    val meetingState by MeetingRecorderService.recordingState.collectAsState()
    val isRecordingMeeting = meetingState is com.ellie.app.service.MeetingRecordState.Recording

    // Periodically poll staged count for Approvals badge
    LaunchedEffect(Unit) {
        while (true) {
            runCatching {
                val res = apiClient.getQueue()
                res.onSuccess { data ->
                    stagedCount = data.count
                }
            }
            delay(15_000)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Surface(
                            modifier = Modifier.size(10.dp),
                            shape = CircleShape,
                            color = StatusOk
                        ) {}
                        Spacer(Modifier.width(10.dp))
                        Text(
                            text = currentScreen.title,
                            color = TextPrimary,
                            fontSize = 20.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                },
                actions = {
                    // Record Meeting Action Button
                    IconButton(onClick = { onOpenMeetingDialog(null, null) }) {
                        Icon(
                            Icons.Default.FiberManualRecord,
                            contentDescription = "Record Meeting",
                            tint = if (isRecordingMeeting) StatusBad else StatusWarn
                        )
                    }

                    // Live Voice Overlay Action Button
                    IconButton(onClick = onOpenVoiceOverlay) {
                        Icon(
                            Icons.Default.Mic,
                            contentDescription = "Live Voice Overlay",
                            tint = AccentSky
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = DarkSurface
                )
            )
        },
        bottomBar = {
            NavigationBar(
                containerColor = DarkSurface,
                contentColor = TextSecondary
            ) {
                Screen.bottomNavScreens.forEach { screen ->
                    val isSelected = currentScreen.route == screen.route
                    NavigationBarItem(
                        selected = isSelected,
                        onClick = {
                            currentScreen = screen
                        },
                        icon = {
                            if (screen == Screen.Approvals && stagedCount > 0) {
                                BadgedBox(
                                    badge = {
                                        Badge(
                                            containerColor = StatusWarn,
                                            contentColor = DarkBg
                                        ) {
                                            Text(stagedCount.toString(), fontWeight = FontWeight.Bold)
                                        }
                                    }
                                ) {
                                    Icon(screen.icon, contentDescription = screen.title)
                                }
                            } else {
                                Icon(screen.icon, contentDescription = screen.title)
                            }
                        },
                        label = { Text(screen.title, fontSize = 11.sp) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = AccentSky,
                            selectedTextColor = AccentSky,
                            indicatorColor = DarkPanel,
                            unselectedIconColor = TextSecondary,
                            unselectedTextColor = TextSecondary
                        )
                    )
                }
            }
        }
    ) { innerPadding ->
        Box(modifier = Modifier.padding(innerPadding).fillMaxSize()) {
            when (currentScreen) {
                Screen.Approvals -> ApprovalsScreen(apiClient = apiClient)
                Screen.Routines -> RoutinesScreen(apiClient = apiClient)
                Screen.Runs -> RunsScreen(apiClient = apiClient)
                Screen.Costs -> CostsScreen(apiClient = apiClient)
                Screen.Spaces -> SpacesScreen(apiClient = apiClient, serverPrefs = serverPreferences)
                Screen.Settings -> SettingsScreen(apiClient = apiClient, serverPrefs = serverPreferences)
            }
        }

        // Two-Way Live Voice Overlay
        if (showVoiceOverlay) {
            LiveVoiceOverlay(
                apiClient = apiClient,
                serverPrefs = serverPreferences,
                onDismiss = onDismissVoiceOverlay,
                onStartMeetingRecorder = { title, instructions ->
                    onOpenMeetingDialog(title, instructions)
                }
            )
        }

        // Triggered Background Meeting Recorder Dialog
        if (showMeetingDialog) {
            MeetingRecorderDialog(
                initialTitle = meetingTitleInit,
                initialInstructions = meetingInstructionsInit,
                onDismiss = onDismissMeetingDialog
            )
        }
    }
}
