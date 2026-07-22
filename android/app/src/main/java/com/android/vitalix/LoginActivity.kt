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
 * Login screen. Also owns the server URL field, since auth needs a base URL
 * and a fresh install has none configured yet. Persists the URL to
 * [SyncSettings] on submit so the sync screen (MainActivity) shares it.
 */
class LoginActivity : AppCompatActivity() {

    private lateinit var editServerUrl: TextInputEditText
    private lateinit var editEmail: TextInputEditText
    private lateinit var editPassword: TextInputEditText
    private lateinit var btnLogin: Button
    private lateinit var txtStatus: TextView

    private val settings by lazy { SyncSettings(this) }
    private val store by lazy { AuthStore(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)

        editServerUrl = findViewById(R.id.editServerUrl)
        editEmail = findViewById(R.id.editEmail)
        editPassword = findViewById(R.id.editPassword)
        btnLogin = findViewById(R.id.btnLogin)
        txtStatus = findViewById(R.id.txtStatus)

        editServerUrl.setText(settings.serverUrl ?: "")

        btnLogin.setOnClickListener { onLoginClicked() }
        findViewById<TextView>(R.id.linkSignup).setOnClickListener {
            startActivity(Intent(this, SignupActivity::class.java))
        }
        findViewById<TextView>(R.id.linkForgot).setOnClickListener {
            startActivity(Intent(this, ForgotActivity::class.java))
        }
    }

    private fun onLoginClicked() {
        val url = editServerUrl.text?.toString()?.trim().orEmpty()
        val email = editEmail.text?.toString()?.trim().orEmpty()
        val password = editPassword.text?.toString().orEmpty()

        if (url.isBlank()) {
            showStatus("Enter a server URL first")
            return
        }
        if (email.isBlank() || password.isBlank()) {
            showStatus("Enter your email and password")
            return
        }

        settings.serverUrl = url
        setBusy(true)
        showStatus("")

        lifecycleScope.launch {
            AuthClient(url).login(email, password).fold(
                onSuccess = { tokens ->
                    store.save(tokens.access, tokens.refresh, email)
                    goMain()
                },
                onFailure = {
                    setBusy(false)
                    showStatus("Invalid email or password.")
                }
            )
        }
    }

    private fun goMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun setBusy(busy: Boolean) {
        btnLogin.isEnabled = !busy
    }

    private fun showStatus(message: String) {
        txtStatus.text = message
    }
}
