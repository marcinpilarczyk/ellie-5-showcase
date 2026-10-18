package com.ellie.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DeleteSweep
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.ellie.app.data.EllieApiClient
import com.ellie.app.data.StagedActionItem
import com.ellie.app.ui.components.EmptyPlaceholder
import com.ellie.app.ui.components.ErrorState
import com.ellie.app.ui.components.LoadingState
import com.ellie.app.ui.components.StatusBadge
import com.ellie.app.ui.theme.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
fun ApprovalsScreen(
    apiClient: EllieApiClient,
    modifier: Modifier = Modifier
) {
    val scope = rememberCoroutineScope()
    var isLoading by remember { mutableStateOf(true) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var stagedActions by remember { mutableStateOf<List<StagedActionItem>>(emptyList()) }
    var editingAction by remember { mutableStateOf<StagedActionItem?>(null) }
    var isProcessing by remember { mutableStateOf(false) }

    fun loadQueue() {
        scope.launch {
            isLoading = true
            errorMessage = null
            val res = apiClient.getQueue()
            res.onSuccess { data ->
                stagedActions = data.items
                isLoading = false
            }.onFailure { err ->
                errorMessage = err.message ?: "Failed to load approval queue"
                isLoading = false
            }
        }
    }

    LaunchedEffect(Unit) {
        loadQueue()
    }

    Box(modifier = modifier.fillMaxSize().background(DarkBg)) {
        when {
            isLoading && stagedActions.isEmpty() -> {
                LoadingState()
            }
            errorMessage != null && stagedActions.isEmpty() -> {
                ErrorState(message = errorMessage ?: "Unknown error", onRetry = { loadQueue() })
            }
            stagedActions.isEmpty() -> {
                EmptyPlaceholder(
                    title = "Approval Queue is Clean",
                    subtitle = "Ellie has no consequential actions waiting for your confirmation."
                )
            }
            else -> {
                Column(modifier = Modifier.fillMaxSize()) {
                    // Batch action toolbar
                    if (stagedActions.size > 1) {
                        Surface(
                            color = DarkPanel,
                            border = androidx.compose.foundation.BorderStroke(1.dp, DarkPanelBorder),
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(12.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = "${stagedActions.size} actions staged",
                                    color = TextPrimary,
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.Medium
                                )
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    FilledTonalButton(
                                        onClick = {
                                            scope.launch {
                                                isProcessing = true
                                                apiClient.approveAllBatch()
                                                isProcessing = false
                                                loadQueue()
                                            }
                                        },
                                        enabled = !isProcessing,
                                        colors = ButtonDefaults.filledTonalButtonColors(
                                            containerColor = StatusOk.copy(alpha = 0.2f),
                                            contentColor = StatusOk
                                        )
                                    ) {
                                        Icon(Icons.Default.DoneAll, contentDescription = null, modifier = Modifier.size(16.dp))
                                        Spacer(Modifier.width(4.dp))
                                        Text("Approve All", fontSize = 12.sp)
                                    }

                                    FilledTonalButton(
                                        onClick = {
                                            scope.launch {
                                                isProcessing = true
                                                apiClient.dropAllBatch()
                                                isProcessing = false
                                                loadQueue()
                                            }
                                        },
                                        enabled = !isProcessing,
                                        colors = ButtonDefaults.filledTonalButtonColors(
                                            containerColor = StatusBad.copy(alpha = 0.2f),
                                            contentColor = StatusBad
                                        )
                                    ) {
                                        Icon(Icons.Default.DeleteSweep, contentDescription = null, modifier = Modifier.size(16.dp))
                                        Spacer(Modifier.width(4.dp))
                                        Text("Drop All", fontSize = 12.sp)
                                    }
                                }
                            }
                        }
                    }

                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        items(stagedActions, key = { it.id }) { action ->
                            StagedActionCard(
                                action = action,
                                isProcessing = isProcessing,
                                onApprove = {
                                    scope.launch {
                                        isProcessing = true
                                        apiClient.approveAction(action.id)
                                        isProcessing = false
                                        loadQueue()
                                    }
                                },
                                onDrop = {
                                    scope.launch {
                                        isProcessing = true
                                        apiClient.dropAction(action.id)
                                        isProcessing = false
                                        loadQueue()
                                    }
                                },
                                onEdit = {
                                    editingAction = action
                                }
                            )
                        }
                    }
                }
            }
        }

        // Inline Edit Modal
        editingAction?.let { action ->
            EditPayloadDialog(
                action = action,
                onDismiss = { editingAction = null },
                onSave = { updatedPayload ->
                    scope.launch {
                        isProcessing = true
                        apiClient.updateStagedPayload(action.id, updatedPayload)
                        editingAction = null
                        isProcessing = false
                        loadQueue()
                    }
                }
            )
        }
    }
}

@Composable
fun StagedActionCard(
    action: StagedActionItem,
    isProcessing: Boolean,
    onApprove: () -> Unit,
    onDrop: () -> Unit,
    onEdit: () -> Unit
) {
    val payload = action.payload
    val to = payload?.get("to")?.jsonPrimitive?.contentOrNull
        ?: payload?.get("recipient")?.jsonPrimitive?.contentOrNull
    val subject = payload?.get("subject")?.jsonPrimitive?.contentOrNull
    val body = payload?.get("body")?.jsonPrimitive?.contentOrNull
        ?: payload?.get("content")?.jsonPrimitive?.contentOrNull
        ?: payload?.toString()

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
                StatusBadge(
                    text = action.actionType,
                    color = when (action.actionType) {
                        "gmail_send", "proton_send" -> StatusWarn
                        "calendar_create" -> AccentSky
                        else -> TextSecondary
                    }
                )
                action.slackChannel?.let { ch ->
                    Text(text = "#$ch", color = TextMuted, fontSize = 12.sp)
                }
            }

            Spacer(modifier = Modifier.height(10.dp))

            to?.let {
                Text(
                    text = "To: $it",
                    color = TextPrimary,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }

            subject?.let {
                Text(
                    text = "Subject: $it",
                    color = AccentSky,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium
                )
                Spacer(modifier = Modifier.height(6.dp))
            }

            body?.let {
                Text(
                    text = it.take(280) + if (it.length > 280) "..." else "",
                    color = TextSecondary,
                    fontSize = 13.sp,
                    lineHeight = 18.sp
                )
            }

            Spacer(modifier = Modifier.height(14.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(
                    onClick = onEdit,
                    enabled = !isProcessing,
                    colors = IconButtonDefaults.iconButtonColors(contentColor = TextSecondary)
                ) {
                    Icon(Icons.Default.Edit, contentDescription = "Edit")
                }

                Spacer(modifier = Modifier.width(4.dp))

                Button(
                    onClick = onDrop,
                    enabled = !isProcessing,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = StatusBad.copy(alpha = 0.15f),
                        contentColor = StatusBad
                    ),
                    shape = RoundedCornerShape(8.dp),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
                ) {
                    Icon(Icons.Default.Close, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("Drop", fontSize = 12.sp)
                }

                Spacer(modifier = Modifier.width(8.dp))

                Button(
                    onClick = onApprove,
                    enabled = !isProcessing,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = StatusOk,
                        contentColor = DarkBg
                    ),
                    shape = RoundedCornerShape(8.dp),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp)
                ) {
                    Icon(Icons.Default.Check, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("Approve & Execute", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
fun EditPayloadDialog(
    action: StagedActionItem,
    onDismiss: () -> Unit,
    onSave: (JsonObject) -> Unit
) {
    val initialPayload = action.payload ?: buildJsonObject {}
    var toText by remember {
        mutableStateOf(
            initialPayload["to"]?.jsonPrimitive?.contentOrNull
                ?: initialPayload["recipient"]?.jsonPrimitive?.contentOrNull ?: ""
        )
    }
    var subjectText by remember {
        mutableStateOf(initialPayload["subject"]?.jsonPrimitive?.contentOrNull ?: "")
    }
    var bodyText by remember {
        mutableStateOf(
            initialPayload["body"]?.jsonPrimitive?.contentOrNull
                ?: initialPayload["content"]?.jsonPrimitive?.contentOrNull ?: ""
        )
    }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            color = DarkPanel,
            shape = RoundedCornerShape(16.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, DarkPanelBorder),
            modifier = Modifier.fillMaxWidth().padding(16.dp)
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text(
                    text = "Edit Staged Action",
                    color = TextPrimary,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = "Adjustments teach Ellie style & tone preferences automatically.",
                    color = TextMuted,
                    fontSize = 12.sp
                )

                Spacer(modifier = Modifier.height(16.dp))

                OutlinedTextField(
                    value = toText,
                    onValueChange = { toText = it },
                    label = { Text("Recipient (To)", color = TextSecondary) },
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary,
                        focusedBorderColor = AccentSky,
                        unfocusedBorderColor = DarkPanelBorder
                    ),
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(modifier = Modifier.height(10.dp))

                OutlinedTextField(
                    value = subjectText,
                    onValueChange = { subjectText = it },
                    label = { Text("Subject", color = TextSecondary) },
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary,
                        focusedBorderColor = AccentSky,
                        unfocusedBorderColor = DarkPanelBorder
                    ),
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(modifier = Modifier.height(10.dp))

                OutlinedTextField(
                    value = bodyText,
                    onValueChange = { bodyText = it },
                    label = { Text("Message Body", color = TextSecondary) },
                    minLines = 5,
                    maxLines = 8,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary,
                        focusedBorderColor = AccentSky,
                        unfocusedBorderColor = DarkPanelBorder
                    ),
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(modifier = Modifier.height(20.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End
                ) {
                    TextButton(onClick = onDismiss) {
                        Text("Cancel", color = TextSecondary)
                    }
                    Spacer(modifier = Modifier.width(8.dp))
                    Button(
                        onClick = {
                            val updated = buildJsonObject {
                                // Preserve existing fields
                                initialPayload.forEach { (k, v) -> put(k, v) }
                                if (toText.isNotBlank()) put("to", toText.trim())
                                if (subjectText.isNotBlank()) put("subject", subjectText.trim())
                                if (bodyText.isNotBlank()) put("body", bodyText.trim())
                            }
                            onSave(updated)
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = AccentSkyDim)
                    ) {
                        Text("Save & Update", color = TextPrimary)
                    }
                }
            }
        }
    }
}
