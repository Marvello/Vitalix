# Vitalix Android Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the Vitalix Android app behind login, add invite-code signup and forgot-password, store JWT access+refresh securely, and attach the access token to every sync — auto-refreshing on 401.

**Architecture:** `AuthStore` (EncryptedSharedPreferences) holds tokens; `AuthClient` (OkHttp) does login/signup/forgot/refresh; a shared OkHttp `Authenticator` transparently refreshes the access token on 401 and retries. A launcher gate routes to `LoginActivity` when there's no session. The manual "auth token" field is removed; server URL stays.

**Tech Stack:** Kotlin, Views/XML, OkHttp, org.json, EncryptedSharedPreferences, coroutines. Depends on the **web auth** plan being deployed (the app authenticates against it).

## Global Constraints

- Work ONLY in `android/`. Do NOT modify `android/healthexport/`.
- Tokens live only in `AuthStore` (EncryptedSharedPreferences) — never in plain prefs, never logged.
- All authenticated requests send `Authorization: Bearer <accessToken>`; on 401, refresh once via `/api/auth/refresh` then retry; if refresh fails, clear the session and surface "Session expired — log in."
- Server base URL comes from `SyncSettings` (existing). Auth endpoints are `<baseUrl>/api/auth/{login,signup,refresh,forgot}`. Note: the sync endpoint is `<serverUrl>` as configured today; keep a single configured base and derive auth paths from it (see Task 1 for URL handling).
- git repo, branch `main`. Commit each task with `git -c user.name='Vitalix Dev' -c user.email='dev@vitalix.local' commit`.
- Build gate each task: `cd android && ./gradlew :app:assembleDebug` (and `:app:testDebugUnitTest` where tests exist).

---

### Task 1: AuthStore + AuthClient (+ pure parsing) — TDD

**Files:** Create `android/app/src/main/java/com/android/vitalix/auth/AuthStore.kt`, `.../auth/AuthClient.kt`; test `android/app/src/test/java/com/android/vitalix/AuthParseTest.kt`

**Interfaces:**
- `AuthStore(context)`: `var accessToken: String?`, `var refreshToken: String?`, `var email: String?`, `fun isLoggedIn(): Boolean`, `fun save(access, refresh, email)`, `fun clear()`.
- `AuthClient(baseUrl)`: `suspend fun login(email, password): Result<Tokens>`, `signup(inviteCode, email, password): Result<Tokens>`, `forgot(email): Result<Unit>`, `refresh(refreshToken): Result<Tokens>`.
- `data class Tokens(access: String, refresh: String)`.
- Pure helpers `AuthClient.parseTokens(json: String): Tokens` and `authBaseFrom(serverUrl: String): String` (derive `<origin>` from the configured sync URL) — unit-tested.

- [ ] **Step 1: Write `AuthParseTest.kt`**

```kotlin
package com.android.vitalix

import com.android.vitalix.auth.AuthClient
import kotlin.test.Test
import kotlin.test.assertEquals

class AuthParseTest {
    @Test fun parsesTokens() {
        val t = AuthClient.parseTokens("""{"access":"a.b.c","refresh":"r1","user":{"id":1}}""")
        assertEquals("a.b.c", t.access); assertEquals("r1", t.refresh)
    }
    @Test fun derivesAuthBaseFromSyncUrl() {
        assertEquals("http://10.0.2.2:3000", AuthClient.authBaseFrom("http://10.0.2.2:3000/api/health"))
        assertEquals("https://vitalix.example.com", AuthClient.authBaseFrom("https://vitalix.example.com/api/health"))
    }
}
```

- [ ] **Step 2: Run → RED.** `cd android && ./gradlew :app:testDebugUnitTest --tests "com.android.vitalix.AuthParseTest"`. Expected FAIL (unresolved).

- [ ] **Step 3: Implement `auth/AuthStore.kt`**

```kotlin
package com.android.vitalix.auth

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class AuthStore(context: Context) {
    private val prefs = run {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context, "vitalix_auth", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }
    var accessToken: String?
        get() = prefs.getString("access", null); set(v) { prefs.edit().putString("access", v).apply() }
    var refreshToken: String?
        get() = prefs.getString("refresh", null); set(v) { prefs.edit().putString("refresh", v).apply() }
    var email: String?
        get() = prefs.getString("email", null); set(v) { prefs.edit().putString("email", v).apply() }

    fun isLoggedIn() = !accessToken.isNullOrBlank() && !refreshToken.isNullOrBlank()
    fun save(access: String, refresh: String, email: String) {
        prefs.edit().putString("access", access).putString("refresh", refresh).putString("email", email).apply()
    }
    fun clear() { prefs.edit().clear().apply() }
}
```

- [ ] **Step 4: Implement `auth/AuthClient.kt`**

```kotlin
package com.android.vitalix.auth

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class Tokens(val access: String, val refresh: String)

class AuthClient(private val baseUrl: String) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()
    private val JSON = "application/json; charset=utf-8".toMediaType()

    private suspend fun post(path: String, body: JSONObject): Result<String> = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url(AuthClient.authBaseFrom(baseUrl) + path)
                .post(body.toString().toRequestBody(JSON)).build()
            client.newCall(req).execute().use { r ->
                val text = r.body?.string() ?: ""
                if (r.isSuccessful) Result.success(text)
                else Result.failure(AuthException(r.code, errorMessage(text)))
            }
        } catch (e: Exception) { Result.failure(e) }
    }

    suspend fun login(email: String, password: String): Result<Tokens> =
        post("/api/auth/login", JSONObject().put("email", email).put("password", password)).map { parseTokens(it) }
    suspend fun signup(inviteCode: String, email: String, password: String): Result<Tokens> =
        post("/api/auth/signup", JSONObject().put("token", inviteCode).put("email", email).put("password", password)).map { parseTokens(it) }
    suspend fun forgot(email: String): Result<Unit> =
        post("/api/auth/forgot", JSONObject().put("email", email)).map { }
    suspend fun refresh(refreshToken: String): Result<Tokens> =
        post("/api/auth/refresh", JSONObject().put("refresh", refreshToken)).map { parseTokens(it) }

    class AuthException(val code: Int, message: String) : Exception(message)

    companion object {
        fun parseTokens(json: String): Tokens {
            val o = JSONObject(json)
            return Tokens(o.getString("access"), o.getString("refresh"))
        }
        fun authBaseFrom(serverUrl: String): String {
            // strip path: keep scheme://host[:port]
            val noScheme = serverUrl.substringAfter("://", serverUrl)
            val scheme = if (serverUrl.contains("://")) serverUrl.substringBefore("://") else "http"
            val hostPort = noScheme.substringBefore("/")
            return "$scheme://$hostPort"
        }
        private fun errorMessage(body: String) = try { JSONObject(body).optString("error", "request failed") } catch (_: Exception) { "request failed" }
    }
}
```

- [ ] **Step 5: Run → GREEN.** `cd android && ./gradlew :app:testDebugUnitTest --tests "com.android.vitalix.AuthParseTest"`. Expected PASS. Then `./gradlew :app:compileDebugKotlin`.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/auth android/app/src/test/java/com/android/vitalix/AuthParseTest.kt
git commit -m "feat(android): AuthStore + AuthClient with pure parsing tests"
```

---

### Task 2: Login / Signup / Forgot activities

**Files:** Create `LoginActivity.kt`, `SignupActivity.kt`, `ForgotActivity.kt` (+ layouts `activity_login.xml`, `activity_signup.xml`, `activity_forgot.xml`); register in `AndroidManifest.xml`

**Interfaces:**
- `LoginActivity`: email+password + buttons → `AuthClient.login` → on success `AuthStore.save(...)` → launch `MainActivity` (finish). Links to Signup + Forgot. Reads base URL from `SyncSettings.serverUrl` (if unset, prompt the user to set the server URL first — a field on the login screen or a settings prompt).
- `SignupActivity`: invite code + email + password → `AuthClient.signup` → save → MainActivity.
- `ForgotActivity`: email → `AuthClient.forgot` → generic "If that account exists, a reset link was sent." (always shown).

- [ ] **Step 1: Layouts** — three simple vertical forms (EditTexts + a primary Vital-Teal button + a status TextView). Login also needs a **server URL** field (since auth needs a base URL and the app may be fresh): prefill from `SyncSettings.serverUrl`, and persist it back on submit so the sync screen shares it.

- [ ] **Step 2: `LoginActivity.kt`** (pattern; Signup/Forgot analogous):

```kotlin
package com.android.vitalix

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.android.vitalix.auth.AuthClient
import com.android.vitalix.auth.AuthStore
import kotlinx.coroutines.launch

class LoginActivity : AppCompatActivity() {
    override fun onCreate(s: Bundle?) {
        super.onCreate(s)
        setContentView(R.layout.activity_login)
        val settings = SyncSettings(this)
        val store = AuthStore(this)
        // bind fields; prefill serverUrl from settings.serverUrl
        findViewById<android.widget.Button>(R.id.btnLogin).setOnClickListener {
            val url = /* serverUrl field */; val email = /* */; val pw = /* */
            if (url.isBlank()) { /* show "set server URL" */ return@setOnClickListener }
            settings.serverUrl = url
            lifecycleScope.launch {
                AuthClient(url).login(email, pw).fold(
                    onSuccess = { t -> store.save(t.access, t.refresh, email); goMain() },
                    onFailure = { /* show generic "Invalid email or password" */ }
                )
            }
        }
        findViewById<android.view.View>(R.id.linkSignup).setOnClickListener { startActivity(Intent(this, SignupActivity::class.java)) }
        findViewById<android.view.View>(R.id.linkForgot).setOnClickListener { startActivity(Intent(this, ForgotActivity::class.java)) }
    }
    private fun goMain() { startActivity(Intent(this, MainActivity::class.java)); finish() }
}
```
Build `SignupActivity` (invite code + email + password → `AuthClient(url).signup(code,email,pw)`; prefill invite code from an `Intent`/deep-link `token` extra if present) and `ForgotActivity` (email → `forgot`, always show the generic confirmation regardless of success/failure — no enumeration).

- [ ] **Step 3: Manifest** — register the three activities. Keep `MainActivity` as the launcher for now (the gate in Task 3 redirects). Optionally add an intent-filter on `SignupActivity` for a `vitalix://signup?token=` deep link (nice-to-have; skip if it complicates the build).

- [ ] **Step 4: Build** — `cd android && ./gradlew :app:assembleDebug` → BUILD SUCCESSFUL.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/LoginActivity.kt android/app/src/main/java/com/android/vitalix/SignupActivity.kt android/app/src/main/java/com/android/vitalix/ForgotActivity.kt android/app/src/main/res/layout/activity_login.xml android/app/src/main/res/layout/activity_signup.xml android/app/src/main/res/layout/activity_forgot.xml android/app/src/main/AndroidManifest.xml
git commit -m "feat(android): login/signup/forgot screens"
```

---

### Task 3: Launch gate + drop the manual auth-token field

**Files:** Modify `MainActivity.kt`, `res/layout/activity_main.xml`

**Interfaces:** On `MainActivity.onCreate`, if `!AuthStore(this).isLoggedIn()` → start `LoginActivity` and `finish()`. Add a "Log out" action that clears `AuthStore` and returns to `LoginActivity`. Remove the auth-token EditText and its persistence.

- [ ] **Step 1: Gate at top of `MainActivity.onCreate`** (before inflating the sync UI):

```kotlin
if (!AuthStore(this).isLoggedIn()) {
    startActivity(Intent(this, LoginActivity::class.java)); finish(); return
}
```

- [ ] **Step 2: Remove the auth-token field** from `activity_main.xml` and all references in `MainActivity.kt` (the field, its load/save via `SyncSettings.authToken`). Server URL field stays. Add a "Log out" button that calls `AuthStore(this).clear()` then routes to `LoginActivity`.

- [ ] **Step 3: `SyncSettings`** — the `authToken` property is now unused by the UI; leave it (harmless) or remove it plus its reads. If removing, update any references. Prefer removing to avoid dead config.

- [ ] **Step 4: Build** — `./gradlew :app:assembleDebug` → SUCCESSFUL. `./gradlew :app:testDebugUnitTest` still green.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/MainActivity.kt android/app/src/main/java/com/android/vitalix/SyncSettings.kt android/app/src/main/res/layout/activity_main.xml
git commit -m "feat(android): gate app behind login, remove manual auth-token field"
```

---

### Task 4: Authenticated sync + refresh-on-401

**Files:** Create `android/app/src/main/java/com/android/vitalix/auth/AuthedHttp.kt`; modify `ServerForwarder.kt`, `ExportWorker.kt`, `MainActivity.kt`

**Interfaces:**
- `AuthedHttp.client(context): OkHttpClient` — an OkHttpClient whose `Authenticator` refreshes the access token on 401 (using `AuthStore` + `AuthClient.refresh`) and retries once; on refresh failure it clears `AuthStore` and gives up (returns null → 401 propagates).
- `ServerForwarder.forward(context, url, json): Result<Int>` — now takes `context` (for the authed client + current token), attaches `Authorization: Bearer <access>`, uses the authed client. (Drop the `token` param.)

- [ ] **Step 1: `auth/AuthedHttp.kt`**

```kotlin
package com.android.vitalix.auth

import android.content.Context
import kotlinx.coroutines.runBlocking
import okhttp3.Authenticator
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route
import com.android.vitalix.SyncSettings
import java.util.concurrent.TimeUnit

object AuthedHttp {
    fun client(context: Context): OkHttpClient {
        val store = AuthStore(context)
        val settings = SyncSettings(context)
        val authenticator = Authenticator { _: Route?, response: Response ->
            if (responseCount(response) >= 2) return@Authenticator null // already retried
            val refresh = store.refreshToken ?: return@Authenticator null
            val base = settings.serverUrl ?: return@Authenticator null
            val newTokens = runBlocking { AuthClient(base).refresh(refresh) }.getOrNull()
            if (newTokens == null) { store.clear(); return@Authenticator null }
            store.save(newTokens.access, newTokens.refresh, store.email ?: "")
            response.request.newBuilder().header("Authorization", "Bearer ${newTokens.access}").build()
        }
        return OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS).writeTimeout(30, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
            .authenticator(authenticator)
            .build()
    }
    private fun responseCount(response: Response): Int {
        var r: Response? = response; var c = 1; while (r?.priorResponse != null) { c++; r = r.priorResponse }; return c
    }
}
```

- [ ] **Step 2: `ServerForwarder.forward`** — accept `context`, use the authed client, attach the current access token:

```kotlin
suspend fun forward(context: Context, url: String, json: String): Result<Int> = withContext(Dispatchers.IO) {
    try {
        val access = AuthStore(context).accessToken
        val builder = Request.Builder().url(url).post(json.toRequestBody(JSON))
        if (!access.isNullOrBlank()) builder.header("Authorization", "Bearer $access")
        AuthedHttp.client(context).newCall(builder.build()).execute().use { resp ->
            if (resp.isSuccessful) Result.success(resp.code)
            else Result.failure(HttpException(resp.code))
        }
    } catch (e: Exception) { Result.failure(e) }
}
```
(Keep `buildPayload` unchanged. Remove the old standalone `client`/`token` usage.)

- [ ] **Step 3: Update callers** — `MainActivity.runSync` and `ExportWorker.doWork` call `ServerForwarder.forward(applicationContext/this, url, json)` (no token arg). In `ExportWorker`, on a `HttpException(401)` after the authenticator already tried and failed (session cleared), return `Result.failure()` and optionally note "session expired" — do not infinite-retry. In `MainActivity`, on a 401 that survives refresh, route to `LoginActivity` (`AuthStore` will have been cleared by the authenticator).

- [ ] **Step 4: Build + tests** — `./gradlew :app:assembleDebug` SUCCESSFUL; `./gradlew :app:testDebugUnitTest` green (ServerForwarder buildPayload tests unaffected; if a test constructed `forward` it doesn't — buildPayload only).

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/auth/AuthedHttp.kt android/app/src/main/java/com/android/vitalix/ServerForwarder.kt android/app/src/main/java/com/android/vitalix/ExportWorker.kt android/app/src/main/java/com/android/vitalix/MainActivity.kt
git commit -m "feat(android): authenticated sync with refresh-on-401"
```

---

### Task 5: End-to-end against the web receiver (device/emulator)

**Files:** none (manual verification)

Requires the **web auth** stack running (`cd web && docker compose up -d`) with an admin created and an invite minted (grab the invite token from `docker compose logs app`).

- [ ] **Step 1: Install** — `cd android && ./gradlew :app:installDebug` to an emulator (use `http://10.0.2.2:3000/api/health` as the server URL to reach the host).
- [ ] **Step 2: Signup** — open the app → Sign up → enter the invite token + the invited email + a password → lands on the sync screen.
- [ ] **Step 3: Grant HC perms**, enable metrics, **Sync now** → "Sent". Verify on web: log in at `http://localhost:3000/login` as that user → `/dashboard` shows the day.
- [ ] **Step 4: Isolation** — the admin's dashboard does NOT show this user's data.
- [ ] **Step 5: Token refresh** — leave the app until the access token expires (or set `ACCESS_TTL=60s` on the server), Sync again → succeeds via silent refresh (no re-login).
- [ ] **Step 6: Forgot password** — from the login screen, Forgot → enter email → generic confirmation; grab the reset link from server logs; reset; log in with the new password.
- [ ] **Step 7: Logout** — log out → app returns to Login; sync is blocked until re-login.
- [ ] **Step 8: Unit suite** — `./gradlew :app:testDebugUnitTest` all green.

---

## Self-Review notes

- **Spec coverage:** AuthStore(encrypted)+AuthClient with pure tests (T1); login/signup(invite)/forgot screens (T2); launch gate + manual-token-field removal + logout (T3); Bearer attach + refresh-on-401 Authenticator, ExportWorker/MainActivity wiring (T4); device e2e incl. isolation, silent refresh, forgot/reset, logout (T5). ✅
- **Type/name consistency:** `Tokens(access,refresh)` from `AuthClient` consumed by activities + `AuthedHttp`; `AuthStore.save/clear/isLoggedIn/accessToken/refreshToken` used across T3/T4; `ServerForwarder.forward(context,url,json)` new signature updated at both call sites (MainActivity, ExportWorker). ✅
- **Security:** tokens only in EncryptedSharedPreferences (`AuthStore`), never logged; refresh-on-401 clears session on failure; no-enumeration preserved by showing generic messages on the client. ✅
- **Dependency:** requires the web auth plan deployed; T5 is manual (needs a device/emulator + running server).
- **Known follow-up:** `runBlocking` inside the OkHttp `Authenticator` is acceptable (authenticator runs off the main thread on an OkHttp dispatcher), but note it; a fully non-blocking refresh could replace it later.
