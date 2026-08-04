package com.android.vitalix

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.textfield.TextInputEditText
import kotlinx.coroutines.launch
import java.time.LocalDate

class OnboardingActivity : AppCompatActivity() {

    private lateinit var editName: TextInputEditText
    private lateinit var editHeight: TextInputEditText
    private lateinit var editWeight: TextInputEditText
    private lateinit var txtStatus: TextView
    private lateinit var btnContinue: Button
    private lateinit var btnSkip: Button

    private val settings by lazy { SyncSettings(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_onboarding)
        applyStatusBarTopPadding()

        editName = findViewById(R.id.editName)
        editHeight = findViewById(R.id.editHeight)
        editWeight = findViewById(R.id.editWeight)
        txtStatus = findViewById(R.id.txtStatus)
        btnContinue = findViewById(R.id.btnContinue)
        btnSkip = findViewById(R.id.btnSkip)

        btnContinue.setOnClickListener { submit() }
        btnSkip.setOnClickListener { finish(skipProfile = true) }
    }

    private fun submit() {
        val name = editName.text?.toString()?.trim()
        val heightCm = editHeight.text?.toString()?.trim()?.toDoubleOrNull()
        val weightKg = editWeight.text?.toString()?.trim()?.toDoubleOrNull()

        if (name.isNullOrBlank()) {
            editName.error = "Required"
            return
        }
        if (heightCm == null || heightCm <= 0) {
            editHeight.error = "Enter a valid height"
            return
        }
        if (weightKg == null || weightKg <= 0) {
            editWeight.error = "Enter a valid weight"
            return
        }

        btnContinue.isEnabled = false
        btnSkip.isEnabled = false
        txtStatus.text = "Saving…"
        txtStatus.visibility = View.VISIBLE

        settings.userName = name
        settings.userHeightCm = heightCm
        settings.userWeightKg = weightKg

        lifecycleScope.launch {
            try {
                val hcm = HealthConnectManager(this@OnboardingActivity)
                val today = LocalDate.now()
                hcm.insertHeightRecord(heightCm, today)
                hcm.insertWeightRecord(weightKg, today)
            } catch (e: Exception) {
                // HC write is best-effort during onboarding; profile is saved regardless
                Toast.makeText(this@OnboardingActivity,
                    "Profile saved. Health Connect write failed — you can sync later.",
                    Toast.LENGTH_LONG).show()
            }
            finish(skipProfile = false)
        }
    }

    private fun finish(skipProfile: Boolean) {
        settings.onboardingComplete = true
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }
}
