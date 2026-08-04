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
    }
}
