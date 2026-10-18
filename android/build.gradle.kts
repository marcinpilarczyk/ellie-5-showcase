plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21" apply false
}

allprojects {
    val localAppData = System.getenv("LOCALAPPDATA")
    if (!localAppData.isNullOrBlank()) {
        layout.buildDirectory.set(file("$localAppData/Android/ellie-build/${project.name}"))
    }
}
