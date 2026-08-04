package com.android.vitalix

import android.app.Application
import com.google.firebase.messaging.FirebaseMessaging
import com.microsoft.clarity.Clarity
import com.microsoft.clarity.ClarityConfig

class VitalixApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Clarity.initialize(this, ClarityConfig(BuildConfig.CLARITY_PROJECT_ID))

        val topic = if (BuildConfig.APPLICATION_ID.endsWith(".beta")) "app-updates-beta" else "app-updates"
        FirebaseMessaging.getInstance().subscribeToTopic(topic)

        // Zealot update checks: the Zealot Android SDK is published only as a
        // JitPack SNAPSHOT (com.github.tryzealot:zealot-android:master-SNAPSHOT),
        // too fragile for a reproducible build. UpdateManager.checkForUpdate()
        // calls Zealot's "latest release for channel" HTTP API directly instead,
        // using BuildConfig.ZEALOT_ENDPOINT / BuildConfig.ZEALOT_CHANNEL_KEY.
        // Invoked from MainActivity.onCreate() on app open.
    }
}
