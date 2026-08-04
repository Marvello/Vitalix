package com.android.vitalix

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.android.vitalix.auth.AuthClient
import com.android.vitalix.auth.AuthStore
import com.google.android.material.textfield.TextInputEditText
import kotlinx.coroutines.launch

/**
 * Signup screen. Invite code is prefilled from the "token" Intent extra when
 * present (e.g. from a deep link). Uses the server URL already configured via
 * [SyncSettings] (set on the login screen) rather than asking for it again.
 */
class SignupActivity : AppCompatActivity() {

    private lateinit var editInviteCode: TextInputEditText
    private lateinit var editEmail: TextInputEditText
    private lateinit var editPassword: TextInputEditText
    private lateinit var btnSignup: Button
    private lateinit var txtStatus: TextView

    private val settings by lazy { SyncSettings(this) }
    private val store by lazy { AuthStore(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_signup)
        applyStatusBarTopPadding()

        editInviteCode = findViewById(R.id.editInviteCode)
        editEmail = findViewById(R.id.editEmail)
        editPassword = findViewById(R.id.editPassword)
        btnSignup = findViewById(R.id.btnSignup)
        txtStatus = findViewById(R.id.txtStatus)

        intent?.getStringExtra("token")?.let { editInviteCode.setText(it) }
        intent?.data?.getQueryParameter("token")?.let { editInviteCode.setText(it) }

        btnSignup.setOnClickListener { onSignupClicked() }
        findViewById<TextView>(R.id.linkLogin).setOnClickListener {
            startActivity(Intent(this, LoginActivity::class.java))
        }
    }

    private fun onSignupClicked() {
        val url = settings.serverUrl?.trim().orEmpty()
        val code = editInviteCode.text?.toString()?.trim().orEmpty()
        val email = editEmail.text?.toString()?.trim().orEmpty()
        val password = editPassword.text?.toString().orEmpty()

        if (url.isBlank()) {
            showStatus("Set the server URL on the login screen first")
            return
        }
        if (code.isBlank() || email.isBlank() || password.isBlank()) {
            showStatus("Fill in the invite code, email, and password")
            return
        }

        setBusy(true)
        showStatus("")

        lifecycleScope.launch {
            AuthClient(url).signup(code, email, password).fold(
                onSuccess = { tokens ->
                    store.save(tokens.access, tokens.refresh, email)
                    goMain()
                },
                onFailure = {
                    setBusy(false)
                    showStatus("Could not sign up. Check your invite code and try again.")
                }
            )
        }
    }

    private fun goMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun setBusy(busy: Boolean) {
        btnSignup.isEnabled = !busy
    }

    private fun showStatus(message: String) {
        txtStatus.text = message
    }
}
