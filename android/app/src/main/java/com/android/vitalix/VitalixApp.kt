package com.android.vitalix

import android.app.Application
import com.microsoft.clarity.Clarity
import com.microsoft.clarity.ClarityConfig

class VitalixApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Clarity.initialize(this, ClarityConfig(BuildConfig.CLARITY_PROJECT_ID))
    }
}
