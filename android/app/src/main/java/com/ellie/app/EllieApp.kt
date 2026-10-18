package com.ellie.app

import android.app.Application
import com.ellie.app.data.EllieApiClient
import com.ellie.app.data.ServerPreferences
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

class EllieApp : Application() {

    lateinit var serverPreferences: ServerPreferences
        private set

    lateinit var apiClient: EllieApiClient
        private set

    override fun onCreate() {
        super.onCreate()
        val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val sw = StringWriter()
                throwable.printStackTrace(PrintWriter(sw))
                File(filesDir, "last_crash.txt").writeText(
                    "Thread: ${thread.name}\nTime: ${java.util.Date()}\n\n$sw"
                )
            } catch (_: Exception) {}
            defaultHandler?.uncaughtException(thread, throwable)
        }
        serverPreferences = ServerPreferences(this)
        apiClient = EllieApiClient(serverPreferences)
    }
}
