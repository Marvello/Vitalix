package com.android.vitalix

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.android.vitalix.auth.AuthClient
import com.google.android.material.textfield.TextInputEditText
import kotlinx.coroutines.launch

/**
 * Forgot-password screen. Always shows the same generic confirmation message
 * regardless of whether the account exists or the request succeeded, to avoid
 * user enumeration.
 */
class ForgotActivity : AppCompatActivity() {

    private lateinit var editEmail: TextInputEditText
    private lateinit var btnSubmit: Button
    private lateinit var txtStatus: TextView

    private val settings by lazy { SyncSettings(this) }

    private val genericMessage = "If that account exists, a reset link was sent."

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_forgot)
        applyStatusBarTopPadding()

        editEmail = findViewById(R.id.editEmail)
        btnSubmit = findViewById(R.id.btnSubmit)
        txtStatus = findViewById(R.id.txtStatus)

        btnSubmit.setOnClickListener { onSubmitClicked() }
        findViewById<TextView>(R.id.linkLogin).setOnClickListener {
            startActivity(Intent(this, LoginActivity::class.java))
        }
    }

    private fun onSubmitClicked() {
        val url = settings.serverUrl?.trim().orEmpty()
        val email = editEmail.text?.toString()?.trim().orEmpty()

        if (url.isBlank()) {
            txtStatus.text = "Set the server URL on the login screen first"
            return
        }
        if (email.isBlank()) {
            txtStatus.text = "Enter your email"
            return
        }

        setBusy(true)
        lifecycleScope.launch {
            // Result intentionally ignored: same message on success or failure,
            // so we never reveal whether the account exists.
            AuthClient(url).forgot(email)
            setBusy(false)
            txtStatus.text = genericMessage
        }
    }

    private fun setBusy(busy: Boolean) {
        btnSubmit.isEnabled = !busy
    }
}
