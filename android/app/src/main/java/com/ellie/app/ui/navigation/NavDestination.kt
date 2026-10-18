package com.ellie.app.ui.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AssignmentTurnedIn
import androidx.compose.material.icons.filled.AttachMoney
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Settings
import androidx.compose.ui.graphics.vector.ImageVector

enum class Screen(val route: String, val title: String) {
    Approvals("approvals", "Approvals"),
    Routines("routines", "Routines"),
    Runs("runs", "Runs"),
    Costs("costs", "Costs"),
    Spaces("spaces", "Spaces"),
    Settings("settings", "Settings");

    val icon: ImageVector
        get() = when (this) {
            Approvals -> Icons.Default.AssignmentTurnedIn
            Routines -> Icons.Default.Schedule
            Runs -> Icons.Default.History
            Costs -> Icons.Default.AttachMoney
            Spaces -> Icons.Default.Dashboard
            Settings -> Icons.Default.Settings
        }

    companion object {
        val bottomNavScreens: List<Screen>
            get() = entries
    }
}
