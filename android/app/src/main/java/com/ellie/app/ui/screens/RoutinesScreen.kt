package com.ellie.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Security
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.ellie.app.data.EllieApiClient
import com.ellie.app.data.RoutineItem
import com.ellie.app.data.SentinelItem
import com.ellie.app.ui.components.EmptyPlaceholder
import com.ellie.app.ui.components.ErrorState
import com.ellie.app.ui.components.LoadingState
import com.ellie.app.ui.components.StatusBadge
import com.ellie.app.ui.theme.*
import kotlinx.coroutines.launch

@Composable
fun RoutinesScreen(
    apiClient: EllieApiClient,
    modifier: Modifier = Modifier
) {
    val scope = rememberCoroutineScope()
    var selectedTab by remember { mutableIntStateOf(0) } // 0: Routines, 1: Sentinels
    var isLoading by remember { mutableStateOf(true) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var routines by remember { mutableStateOf<List<RoutineItem>>(emptyList()) }
    var sentinels by remember { mutableStateOf<List<SentinelItem>>(emptyList()) }
    var editingRoutine by remember { mutableStateOf<RoutineItem?>(null) }
    var actionMessage by remember { mutableStateOf<String?>(null) }

    fun loadData() {
        scope.launch {
            isLoading = true
            errorMessage = null
            val rRes = apiClient.getRoutines()
            val sRes = apiClient.getSentinels()

            rRes.onSuccess { routines = it.routines }
                .onFailure { errorMessage = it.message }

            sRes.onSuccess { sentinels = it.sentinels }
                .onFailure { if (errorMessage == null) errorMessage = it.message }

            isLoading = false
        }
    }

    LaunchedEffect(Unit) {
        loadData()
    }

    Column(modifier = modifier.fillMaxSize().background(DarkBg)) {
        // Tab selector
        TabRow(
            selectedTabIndex = selectedTab,
            containerColor = DarkSurface,
            contentColor = AccentSky,
            divider = {}
        ) {
            Tab(
                selected = selectedTab == 0,
                onClick = { selectedTab = 0 },
                text = { Text("Scheduled Routines (${routines.size})", fontWeight = FontWeight.SemiBold) }
            )
            Tab(
                selected = selectedTab == 1,
                onClick = { selectedTab = 1 },
                text = { Text("Autonomous Sentinels (${sentinels.size})", fontWeight = FontWeight.SemiBold) }
            )
        }

        actionMessage?.let { msg ->
            Surface(
                color = AccentSkyDim.copy(alpha = 0.2f),
                modifier = Modifier.fillMaxWidth().padding(12.dp),
                shape = RoundedCornerShape(8.dp)
            ) {
                Text(
                    text = msg,
                    color = AccentSky,
                    fontSize = 13.sp,
                    modifier = Modifier.padding(10.dp)
                )
            }
        }

        Box(modifier = Modifier.fillMaxSize()) {
            when {
                isLoading && routines.isEmpty() && sentinels.isEmpty() -> {
                    LoadingState()
                }
                errorMessage != null && routines.isEmpty() && sentinels.isEmpty() -> {
                    ErrorState(message = errorMessage ?: "Unknown error", onRetry = { loadData() })
                }
                selectedTab == 0 -> {
                    if (routines.isEmpty()) {
                        EmptyPlaceholder(title = "No Routines Configured", subtitle = "Ask Ellie via voice or Slack to create recurring routines.")
                    } else {
                        LazyColumn(
                            contentPadding = PaddingValues(16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            items(routines, key = { it.id }) { routine ->
                                RoutineCard(
                                    routine = routine,
                                    onToggle = {
                                        scope.launch {
                                            apiClient.toggleRoutine(routine.id)
                                            loadData()
                                        }
                                    },
                                    onRunNow = {
                                        scope.launch {
                                            val res = apiClient.runRoutineNow(routine.id)
                                            res.onSuccess { actionMessage = "Started routine '${routine.title}'. Output will deliver to Slack." }
                                                .onFailure { actionMessage = "Failed to run routine: ${it.message}" }
                                        }
                                    },
                                    onEdit = { editingRoutine = routine },
                                    onDelete = {
                                        scope.launch {
                                            apiClient.deleteRoutine(routine.id)
                                            loadData()
                                        }
                                    }
                                )
                            }
                        }
                    }
                }
                selectedTab == 1 -> {
                    if (sentinels.isEmpty()) {
                        EmptyPlaceholder(title = "No Sentinels Registered", subtitle = "Gmail, Calendar and Proton sentinels will appear here.")
                    } else {
                        LazyColumn(
                            contentPadding = PaddingValues(16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            items(sentinels, key = { it.id }) { sentinel ->
                                SentinelCard(
                                    sentinel = sentinel,
                                    onToggle = {
                                        scope.launch {
                                            apiClient.toggleSentinel(sentinel.id)
                                            loadData()
                                        }
                                    },
                                    onRunCheck = {
                                        scope.launch {
                                            actionMessage = "Running check for ${sentinel.name}..."
                                            val res = apiClient.runSentinelNow(sentinel.id)
                                            res.onSuccess { actionMessage = "${sentinel.name} check completed cleanly." }
                                                .onFailure { actionMessage = "Sentinel check failed: ${it.message}" }
                                        }
                                    }
                                )
                            }
                        }
                    }
                }
            }
        }

        // Edit Routine Dialog
        editingRoutine?.let { r ->
            EditRoutineDialog(
                routine = r,
                onDismiss = { editingRoutine = null },
                onSave = { title, cron, dest, desc ->
                    scope.launch {
                        apiClient.updateRoutine(r.id, title, cron, dest, desc)
                        editingRoutine = null
                        loadData()
                    }
                }
            )
        }
    }
}

@Composable
fun RoutineCard(
    routine: RoutineItem,
    onToggle: () -> Unit,
    onRunNow: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit
) {
    Surface(
        color = DarkSurface,
        shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, DarkPanelBorder),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = routine.title,
                        color = TextPrimary,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = routine.cadence_description ?: routine.cron_schedule,
                        color = AccentSky,
                        fontSize = 13.sp
                    )
                }

                Switch(
                    checked = routine.is_active == 1,
                    onCheckedChange = { onToggle() },
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = TextPrimary,
                        checkedTrackColor = StatusOk,
                        uncheckedTrackColor = DarkPanel
                    )
                )
            }

            routine.description?.let { desc ->
                Spacer(modifier = Modifier.height(8.dp))
                Text(text = desc, color = TextSecondary, fontSize = 13.sp)
            }

            Spacer(modifier = Modifier.height(10.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                routine.last_run_status?.let { status ->
                    StatusBadge(
                        text = status,
                        color = if (status == "COMPLETED" || status == "DONE") StatusOk else StatusWarn
                    )
                } ?: Text("Never run", color = TextMuted, fontSize = 12.sp)

                Row {
                    IconButton(onClick = onEdit) {
                        Icon(Icons.Default.Edit, contentDescription = "Edit", tint = TextSecondary)
                    }
                    IconButton(onClick = onDelete) {
                        Icon(Icons.Default.Delete, contentDescription = "Delete", tint = StatusBad.copy(alpha = 0.7f))
                    }
                    Button(
                        onClick = onRunNow,
                        colors = ButtonDefaults.buttonColors(containerColor = AccentSkyDim),
                        shape = RoundedCornerShape(8.dp),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)
                    ) {
                        Icon(Icons.Default.PlayArrow, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("Run Now", fontSize = 12.sp)
                    }
                }
            }
        }
    }
}

@Composable
fun SentinelCard(
    sentinel: SentinelItem,
    onToggle: () -> Unit,
    onRunCheck: () -> Unit
) {
    Surface(
        color = DarkSurface,
        shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, DarkPanelBorder),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
                Icon(Icons.Default.Security, contentDescription = null, tint = AccentSky, modifier = Modifier.size(28.dp))
                Spacer(Modifier.width(12.dp))
                Column {
                    Text(
                        text = sentinel.name.ifBlank { sentinel.id },
                        color = TextPrimary,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = sentinel.last_status ?: "Active sentinel polling",
                        color = TextSecondary,
                        fontSize = 12.sp
                    )
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                Button(
                    onClick = onRunCheck,
                    colors = ButtonDefaults.buttonColors(containerColor = DarkPanel),
                    shape = RoundedCornerShape(8.dp),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
                ) {
                    Text("Check", fontSize = 12.sp, color = TextPrimary)
                }
                Spacer(Modifier.width(8.dp))
                Switch(
                    checked = sentinel.is_active == 1,
                    onCheckedChange = { onToggle() },
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = TextPrimary,
                        checkedTrackColor = StatusOk,
                        uncheckedTrackColor = DarkPanel
                    )
                )
            }
        }
    }
}

@Composable
fun EditRoutineDialog(
    routine: RoutineItem,
    onDismiss: () -> Unit,
    onSave: (title: String, cron: String, dest: String, desc: String?) -> Unit
) {
    var title by remember { mutableStateOf(routine.title) }
    var cron by remember { mutableStateOf(routine.cron_schedule) }
    var dest by remember { mutableStateOf(routine.destination ?: "Slack") }
    var desc by remember { mutableStateOf(routine.description ?: "") }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            color = DarkPanel,
            shape = RoundedCornerShape(16.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, DarkPanelBorder),
            modifier = Modifier.fillMaxWidth().padding(16.dp)
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text("Edit Routine", color = TextPrimary, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(14.dp))

                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("Title", color = TextSecondary) },
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))

                OutlinedTextField(
                    value = cron,
                    onValueChange = { cron = it },
                    label = { Text("Cron Schedule", color = TextSecondary) },
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))

                OutlinedTextField(
                    value = dest,
                    onValueChange = { dest = it },
                    label = { Text("Destination", color = TextSecondary) },
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))

                OutlinedTextField(
                    value = desc,
                    onValueChange = { desc = it },
                    label = { Text("Description / Prompt", color = TextSecondary) },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(Modifier.height(18.dp))

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text("Cancel", color = TextSecondary) }
                    Spacer(Modifier.width(8.dp))
                    Button(
                        onClick = { onSave(title, cron, dest, desc.ifBlank { null }) },
                        colors = ButtonDefaults.buttonColors(containerColor = AccentSkyDim)
                    ) {
                        Text("Save", color = TextPrimary)
                    }
                }
            }
        }
    }
}
