package com.android.vitalix

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.android.vitalix.auth.AuthClient
import com.android.vitalix.auth.AuthStore
import com.google.android.material.progressindicator.CircularProgressIndicator
import com.google.android.material.textfield.TextInputEditText
import kotlinx.coroutines.launch

/**
 * Login screen. Also owns the server URL field, since auth needs a base URL
 * and a fresh install has none configured yet. Persists the URL to
 * [SyncSettings] on submit so the sync screen (MainActivity) shares it.
 */
class LoginActivity : AppCompatActivity() {

    private lateinit var txtServerUrl: TextView
    private lateinit var btnChangeServerUrl: Button
    private lateinit var editEmail: TextInputEditText
    private lateinit var editPassword: TextInputEditText
    private lateinit var btnLogin: Button
    private lateinit var txtStatus: TextView
    private lateinit var progressLogin: CircularProgressIndicator

    private val settings by lazy { SyncSettings(this) }
    private val store by lazy { AuthStore(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)
        applySystemBarsPadding()

        txtServerUrl = findViewById(R.id.txtServerUrl)
        btnChangeServerUrl = findViewById(R.id.btnChangeServerUrl)
        editEmail = findViewById(R.id.editEmail)
        editPassword = findViewById(R.id.editPassword)
        btnLogin = findViewById(R.id.btnLogin)
        txtStatus = findViewById(R.id.txtStatus)
        progressLogin = findViewById(R.id.progressLogin)

        showServerUrl()
        btnChangeServerUrl.setOnClickListener {
            ServerUrlDialog.show(this, settings) { showServerUrl() }
        }

        btnLogin.setOnClickListener { onLoginClicked() }
        findViewById<TextView>(R.id.linkSignup).setOnClickListener {
            startActivity(Intent(this, SignupActivity::class.java))
        }
        findViewById<TextView>(R.id.linkForgot).setOnClickListener {
            startActivity(Intent(this, ForgotActivity::class.java))
        }
    }

    private fun showServerUrl() {
        val url = settings.serverUrl
        txtServerUrl.text = if (url.isNullOrBlank()) "Server not set" else "Server: $url"
    }

    private fun onLoginClicked() {
        val url = settings.serverUrl?.trim().orEmpty()
        val email = editEmail.text?.toString()?.trim().orEmpty()
        val password = editPassword.text?.toString().orEmpty()

        if (url.isBlank()) {
            showStatus("No server URL set — tap Change")
            return
        }
        if (email.isBlank() || password.isBlank()) {
            showStatus("Enter your email and password")
            return
        }

        if (!isOnline()) {
            showStatus("No internet connection.")
            return
        }

        setBusy(true)
        showStatus("Signing in\u2026")

        lifecycleScope.launch {
            AuthClient(url).login(email, password).fold(
                onSuccess = { tokens ->
                    store.save(tokens.access, tokens.refresh, email)
                    goMain()
                },
                onFailure = { e ->
                    setBusy(false)
                    showStatus(loginErrorMessage(e))
                }
            )
        }
    }

    /** Turns a login failure into a message that says what actually went wrong. */
    private fun loginErrorMessage(e: Throwable): String = when (e) {
        is AuthClient.AuthException ->
            if (e.code == 401) "Invalid email or password."
            else e.message?.takeIf { it.isNotBlank() } ?: "Server error (${e.code})."
        else -> "Can't reach the server. Check it's deployed and the URL is correct."
    }

    private fun goMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun setBusy(busy: Boolean) {
        btnLogin.isEnabled = !busy
        progressLogin.visibility = if (busy) android.view.View.VISIBLE else android.view.View.GONE
    }

    private fun isOnline(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun showStatus(message: String) {
        txtStatus.text = message
    }
}
