package com.ellie.app.ui.screens

import android.annotation.SuppressLint
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.ellie.app.data.EllieApiClient
import com.ellie.app.data.ServerPreferences
import com.ellie.app.data.SpaceItem
import com.ellie.app.ui.components.EmptyPlaceholder
import com.ellie.app.ui.components.ErrorState
import com.ellie.app.ui.components.LoadingState
import com.ellie.app.ui.components.StatusBadge
import com.ellie.app.ui.theme.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

@Composable
fun SpacesScreen(
    apiClient: EllieApiClient,
    serverPrefs: ServerPreferences,
    modifier: Modifier = Modifier
) {
    val scope = rememberCoroutineScope()
    val categories = listOf("All", "Reports", "Radars", "Dashboards", "Trackers")
    var selectedCategory by remember { mutableStateOf("All") }
    var searchQuery by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(true) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var spaces by remember { mutableStateOf<List<SpaceItem>>(emptyList()) }
    var activeSpaceUrl by remember { mutableStateOf<String?>(null) }

    fun loadSpaces() {
        scope.launch {
            isLoading = true
            errorMessage = null
            val res = apiClient.getSpaces(
                category = if (selectedCategory == "All") null else selectedCategory,
                search = if (searchQuery.isBlank()) null else searchQuery
            )
            res.onSuccess { data ->
                spaces = data.spaces
                isLoading = false
            }.onFailure { err ->
                errorMessage = err.message ?: "Failed to load spaces"
                isLoading = false
            }
        }
    }

    LaunchedEffect(selectedCategory) {
        loadSpaces()
    }

    Column(modifier = modifier.fillMaxSize().background(DarkBg)) {
        // Search & Filter Header
        Surface(
            color = DarkSurface,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                OutlinedTextField(
                    value = searchQuery,
                    onValueChange = {
                        searchQuery = it
                        loadSpaces()
                    },
                    placeholder = { Text("Search published spaces...", color = TextMuted) },
                    leadingIcon = { Icon(Icons.Default.Search, contentDescription = null, tint = TextMuted) },
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary,
                        focusedBorderColor = AccentSky,
                        unfocusedBorderColor = DarkPanelBorder
                    ),
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(Modifier.height(8.dp))

                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    categories.forEach { cat ->
                        FilterChip(
                            selected = selectedCategory == cat,
                            onClick = { selectedCategory = cat },
                            label = { Text(cat) },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = AccentSkyDim,
                                selectedLabelColor = TextPrimary,
                                containerColor = DarkPanel,
                                labelColor = TextSecondary
                            )
                        )
                    }
                }
            }
        }

        Box(modifier = Modifier.fillMaxSize()) {
            when {
                isLoading && spaces.isEmpty() -> {
                    LoadingState()
                }
                errorMessage != null && spaces.isEmpty() -> {
                    ErrorState(message = errorMessage ?: "Unknown error", onRetry = { loadSpaces() })
                }
                spaces.isEmpty() -> {
                    EmptyPlaceholder(
                        title = "No Spaces Found",
                        subtitle = "Ellie hasn't published spaces matching this filter."
                    )
                }
                else -> {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        items(spaces, key = { it.slug }) { space ->
                            SpaceCard(
                                space = space,
                                onOpen = {
                                    scope.launch {
                                        val base = serverPrefs.baseUrl.first().trim().trimEnd('/')
                                        activeSpaceUrl = "$base/spaces/${space.slug}"
                                    }
                                },
                                onArchive = {
                                    scope.launch {
                                        apiClient.archiveSpace(space.slug)
                                        loadSpaces()
                                    }
                                },
                                onDelete = {
                                    scope.launch {
                                        apiClient.deleteSpace(space.slug)
                                        loadSpaces()
                                    }
                                }
                            )
                        }
                    }
                }
            }
        }

        // Full-Screen WebView Modal for Spaces
        activeSpaceUrl?.let { url ->
            SpaceWebViewDialog(
                url = url,
                serverPrefs = serverPrefs,
                onDismiss = { activeSpaceUrl = null }
            )
        }
    }
}

@Composable
fun SpaceCard(
    space: SpaceItem,
    onOpen: () -> Unit,
    onArchive: () -> Unit,
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
                StatusBadge(
                    text = space.category,
                    color = AccentSky
                )
                Text(
                    text = "/${space.slug}",
                    color = TextMuted,
                    fontSize = 12.sp
                )
            }

            Spacer(Modifier.height(8.dp))

            Text(
                text = space.title,
                color = TextPrimary,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold
            )

            space.description?.let { desc ->
                Spacer(Modifier.height(4.dp))
                Text(
                    text = desc,
                    color = TextSecondary,
                    fontSize = 13.sp,
                    lineHeight = 18.sp
                )
            }

            Spacer(Modifier.height(14.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                StatusBadge(
                    text = space.status,
                    color = if (space.status == "active") StatusOk else StatusWarn
                )

                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    IconButton(onClick = onArchive) {
                        Icon(Icons.Default.Archive, contentDescription = "Archive", tint = TextSecondary)
                    }
                    IconButton(onClick = onDelete) {
                        Icon(Icons.Default.Delete, contentDescription = "Delete", tint = StatusBad.copy(alpha = 0.7f))
                    }
                    Button(
                        onClick = onOpen,
                        colors = ButtonDefaults.buttonColors(containerColor = AccentSkyDim),
                        shape = RoundedCornerShape(8.dp),
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp)
                    ) {
                        Icon(Icons.Default.OpenInBrowser, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("Open Space", fontSize = 12.sp, color = TextPrimary)
                    }
                }
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun SpaceWebViewDialog(
    url: String,
    serverPrefs: ServerPreferences,
    onDismiss: () -> Unit
) {
    val scope = rememberCoroutineScope()
    var token by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        token = serverPrefs.controlPlaneToken.first().trim()
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Surface(
            color = DarkBg,
            modifier = Modifier.fillMaxSize()
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                // Modal Top Bar
                Surface(
                    color = DarkSurface,
                    border = androidx.compose.foundation.BorderStroke(1.dp, DarkPanelBorder),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = url.substringAfterLast('/'),
                            color = TextPrimary,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Bold
                        )
                        IconButton(onClick = onDismiss) {
                            Icon(Icons.Default.Close, contentDescription = "Close", tint = TextPrimary)
                        }
                    }
                }

                // Interactive WebView
                AndroidView(
                    factory = { ctx ->
                        WebView(ctx).apply {
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            settings.cacheMode = WebSettings.LOAD_NO_CACHE
                            webViewClient = WebViewClient()

                            val headers = mutableMapOf<String, String>()
                            if (token.isNotBlank()) {
                                headers["Authorization"] = "Bearer $token"
                            }
                            loadUrl(url, headers)
                        }
                    },
                    update = { webView ->
                        val headers = mutableMapOf<String, String>()
                        if (token.isNotBlank()) {
                            headers["Authorization"] = "Bearer $token"
                        }
                        webView.loadUrl(url, headers)
                    },
                    modifier = Modifier.fillMaxSize()
                )
            }
        }
    }
}
