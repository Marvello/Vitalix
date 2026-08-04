# Improvement Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement five items from feature request 03 — payload chunking fix, QR in invite email, product flavors, Firebase SDK, and Zealot in-app update mechanism.

**Architecture:** Four phases: (1) product flavors + Firebase SDK as foundation, (2) HTTP payload chunking as independent bug fix, (3) QR in invite email as independent web change, (4) Zealot SDK + in-app update + FCM webhook building on phase 1. Phases 2 and 3 are independent of all other phases.

**Tech Stack:** Android (Kotlin, Gradle 9.5, AGP 9.3.0, OkHttp 4.12, WorkManager 2.9.1), Web (Node.js, Express, Postgres, nodemailer), Firebase Cloud Messaging, Zealot SDK for Android, `qrcode` npm package.

## Global Constraints

- Android: `compileSdk release(37)`, `minSdk 30`, `targetSdk 37`, Java 11
- Android dependencies use `libs.*` aliases from `android/gradle/libs.versions.toml`
- Web: ESM modules (`import`/`export`), Express JSON limit is 25MB
- App name: "Vitalix" for production, "Vitalix Beta" for beta
- Branding colors: `#0FA9A0` (Vital Teal), `#34D399` (Pulse Green)
- Package: `com.android.vitalix` (production), `com.android.vitalix.beta` (beta)
- All Kotlin source lives under `android/app/src/main/java/com/android/vitalix/`
- Web source lives under `web/src/`
- Zealot endpoint: `https://zealot.ews.im` SDK docs for Android

---

### Task 1: Product Flavors

Convert the current build-type-based beta separation into proper product flavors so each environment gets its own applicationId, app name, and resources.

**Files:**
- Modify: `android/app/build.gradle.kts:44-105` (android block — add flavors, restructure build types)
- Modify: `android/fastlane/Fastfile:1-38` (update task names)
- Create: `android/app/src/beta/res/values/strings.xml` (beta app name override — optional, using resValue instead)

**Interfaces:**
- Consumes: nothing
- Produces: `BuildConfig.APPLICATION_ID` (either `com.android.vitalix` or `com.android.vitalix.beta`), `BuildConfig.ZEALOT_ENDPOINT`, `BuildConfig.ZEALOT_CHANNEL_KEY` — used by Tasks 4 and 5.

- [ ] **Step 1: Add product flavors to build.gradle.kts**

Replace the `buildTypes` block and add flavors. The key changes: (a) add `flavorDimensions` + `productFlavors`, (b) remove `applicationIdSuffix` and `versionNameSuffix` from the old `beta` build type, (c) remove the `beta` build type entirely (flavor handles it), (d) add `buildConfigField` entries for Zealot.

In `android/app/build.gradle.kts`, after the `signingConfigs` block (line 63), before `defaultConfig` (line 65), add flavors. Then simplify `buildTypes` to just `debug` and `release`.

```kotlin
// Inside android { } block, after signingConfigs, before defaultConfig:

    flavorDimensions += "environment"
    productFlavors {
        create("production") {
            dimension = "environment"
            applicationId = "com.android.vitalix"
            resValue("string", "app_name", "Vitalix")
            buildConfigField("String", "ZEALOT_ENDPOINT",
                "\"${project.findProperty("ZEALOT_ENDPOINT") ?: System.getenv("ZEALOT_ENDPOINT") ?: ""}\"")
            buildConfigField("String", "ZEALOT_CHANNEL_KEY",
                "\"${project.findProperty("ZEALOT_PROD_CHANNEL_KEY") ?: System.getenv("ZEALOT_PROD_CHANNEL_KEY") ?: ""}\"")
        }
        create("beta") {
            dimension = "environment"
            applicationId = "com.android.vitalix.beta"
            resValue("string", "app_name", "Vitalix Beta")
            buildConfigField("String", "ZEALOT_ENDPOINT",
                "\"${project.findProperty("ZEALOT_ENDPOINT") ?: System.getenv("ZEALOT_ENDPOINT") ?: ""}\"")
            buildConfigField("String", "ZEALOT_CHANNEL_KEY",
                "\"${project.findProperty("ZEALOT_BETA_CHANNEL_KEY") ?: System.getenv("ZEALOT_BETA_CHANNEL_KEY") ?: ""}\"")
        }
    }
```

Remove the entire `create("beta")` build type block (lines 91-97). The `release` build type keeps the production signing config; debug keeps no signing config (default). Assign signing per variant:

```kotlin
    buildTypes {
        debug {
            buildConfigField("String", "DEFAULT_SERVER_URL", serverUrl(defaultDebugServerUrl()))
        }
        release {
            signingConfig = signingConfigs.getByName("production")
            buildConfigField("String", "DEFAULT_SERVER_URL", serverUrl(""))
            optimization {
                enable = false
            }
        }
    }

    // After buildTypes, override signing for beta+release:
    applicationVariants.configureEach {
        if (flavorName == "beta" && buildType.name == "release") {
            signingConfig = signingConfigs.getByName("beta")
        }
    }
```

- [ ] **Step 2: Remove hardcoded app_name from strings.xml**

The flavor `resValue("string", "app_name", ...)` will conflict with any `app_name` in `src/main/res/values/strings.xml`. Remove the `<string name="app_name">` entry from `strings.xml` if it exists. The manifest already uses `@string/app_name`.

```bash
grep -n "app_name" android/app/src/main/res/values/strings.xml
# If found, remove that <string> element
```

- [ ] **Step 3: Update Fastlane build tasks**

In `android/fastlane/Fastfile`, update the gradle task names to use the new flavor+buildType combinations:

```ruby
default_platform(:android)

platform :android do
  desc "Runs all the tests"
  lane :test do
    gradle(task: "test")
  end

  desc "Submit a new Beta Build to Zealot"
  lane :beta do
    gradle(task: "clean assembleBetaRelease")

    zealot(
      endpoint: ENV["ZEALOT_ENDPOINT"],
      token: ENV["ZEALOT_TOKEN"],
      channel_key: ENV["ZEALOT_BETA_CHANNEL_KEY"],
      changelog: changelog_from_git_commits(commits_count: 10, pretty: "- %s"),
      release_type: "beta",
      branch: git_branch,
      git_commit: last_git_commit[:commit_hash]
    )
  end

  desc "Deploy a new production version to Zealot"
  lane :production do
    gradle(task: "clean assembleProductionRelease")

    zealot(
      endpoint: ENV["ZEALOT_ENDPOINT"],
      token: ENV["ZEALOT_TOKEN"],
      channel_key: ENV["ZEALOT_PROD_CHANNEL_KEY"],
      changelog: changelog_from_git_commits(commits_count: 10, pretty: "- %s"),
      release_type: "release",
      branch: git_branch,
      git_commit: last_git_commit[:commit_hash]
    )
  end
end
```

- [ ] **Step 4: Verify both flavors build**

```bash
cd android
./gradlew assembleBetaDebug assembleProductionDebug
```

Expected: both APKs produced. Check applicationId in each:

```bash
aapt dump badging app/build/outputs/apk/beta/debug/app-beta-debug.apk | grep package
# Should show: package name='com.android.vitalix.beta'
aapt dump badging app/build/outputs/apk/production/debug/app-production-debug.apk | grep package
# Should show: package name='com.android.vitalix'
```

- [ ] **Step 5: Commit**

```bash
git add android/app/build.gradle.kts android/fastlane/Fastfile android/app/src/main/res/values/strings.xml
git commit -m "feat: replace beta build type with product flavors

Production (com.android.vitalix) and beta (com.android.vitalix.beta)
are now proper flavors with distinct app names and Zealot channel keys.
Fastlane lanes updated to assembleBetaRelease/assembleProductionRelease."
```

---

### Task 2: Firebase SDK Integration

Wire the Firebase Cloud Messaging SDK into the Android app. `google-services.json` already exists with both app IDs registered.

**Files:**
- Modify: `android/gradle/libs.versions.toml:1-48` (add google-services and firebase-messaging entries)
- Modify: `android/build.gradle.kts` (project-level — apply google-services plugin)
- Modify: `android/app/build.gradle.kts:7-9` (apply plugin, add dependency)
- Modify: `android/app/src/main/java/com/android/vitalix/VitalixApp.kt:1-12` (subscribe to FCM topic)
- Create: `android/app/src/main/java/com/android/vitalix/VitalixFirebaseService.kt`
- Modify: `android/app/src/main/AndroidManifest.xml:65-152` (register service)

**Interfaces:**
- Consumes: `BuildConfig.APPLICATION_ID` from Task 1 (to determine FCM topic name)
- Produces: `VitalixFirebaseService` class (used by Task 5 for update notification handling). FCM topic subscription `app-updates` or `app-updates-beta`.

- [ ] **Step 1: Add Firebase entries to version catalog**

In `android/gradle/libs.versions.toml`, add to `[versions]`:

```toml
googleServices = "4.5.0"
firebaseMessaging = "24.1.0"
```

Add to `[libraries]`:

```toml
firebase-messaging = { group = "com.google.firebase", name = "firebase-messaging", version.ref = "firebaseMessaging" }
```

Add to `[plugins]`:

```toml
google-services = { id = "com.google.gms.google-services", version.ref = "googleServices" }
```

- [ ] **Step 2: Apply google-services plugin at project level**

In `android/build.gradle.kts` (project-level), add the plugin:

```kotlin
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.google.services) apply false
}
```

- [ ] **Step 3: Apply plugin and add dependency in app build.gradle.kts**

In `android/app/build.gradle.kts`, add to the plugins block:

```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.google.services)
}
```

Add to dependencies:

```kotlin
implementation(libs.firebase.messaging)
```

- [ ] **Step 4: Create VitalixFirebaseService**

Create `android/app/src/main/java/com/android/vitalix/VitalixFirebaseService.kt`:

```kotlin
package com.android.vitalix

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class VitalixFirebaseService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        Log.d(TAG, "FCM token refreshed")
        // Token registration with server is implemented in Task 5
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        Log.d(TAG, "FCM message received: type=${data["type"]}")
        // Update notification handling is implemented in Task 5
    }

    companion object {
        private const val TAG = "VitalixFCM"
    }
}
```

- [ ] **Step 5: Register service in AndroidManifest.xml**

In `android/app/src/main/AndroidManifest.xml`, inside the `<application>` tag (before the closing `</application>` on line 152), add:

```xml
        <service
            android:name=".VitalixFirebaseService"
            android:exported="false">
            <intent-filter>
                <action android:name="com.google.firebase.MESSAGING_EVENT" />
            </intent-filter>
        </service>
```

- [ ] **Step 6: Subscribe to FCM topic on startup**

In `android/app/src/main/java/com/android/vitalix/VitalixApp.kt`, add FCM topic subscription:

```kotlin
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
```

- [ ] **Step 7: Verify build compiles with Firebase**

```bash
cd android
./gradlew assembleProductionDebug
```

Expected: BUILD SUCCESSFUL. The google-services plugin processes `google-services.json` and matches the `com.android.vitalix` applicationId.

- [ ] **Step 8: Commit**

```bash
git add android/gradle/libs.versions.toml android/build.gradle.kts android/app/build.gradle.kts \
  android/app/src/main/java/com/android/vitalix/VitalixFirebaseService.kt \
  android/app/src/main/java/com/android/vitalix/VitalixApp.kt \
  android/app/src/main/AndroidManifest.xml
git commit -m "feat: wire Firebase Cloud Messaging SDK

google-services plugin applied, firebase-messaging dep added.
VitalixFirebaseService registered for token refresh and message
receipt. App subscribes to app-updates or app-updates-beta topic
based on flavor applicationId."
```

---

### Task 3: Payload Chunking (Bug Fix)

Add two-tier chunking to `ServerForwarder` — day-based primary split with size fallback — and wire it into `ExportWorker`, `BackfillWorker`, and `MainActivity` manual sync.

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/ServerForwarder.kt:17-115` (add `PayloadTooLargeException`, `ChunkMeta`, `forwardChunked()`)
- Modify: `android/app/src/main/java/com/android/vitalix/ExportWorker.kt:24-75` (use `forwardChunked()`, handle 413)
- Modify: `android/app/src/main/java/com/android/vitalix/BackfillWorker.kt:114-133` (add 413 retry with sub-split)
- Modify: `android/app/src/main/java/com/android/vitalix/MainActivity.kt:652-666` (use `forwardChunked()`)
- Create: `android/app/src/test/java/com/android/vitalix/ChunkingTest.kt`

**Interfaces:**
- Consumes: `ServerForwarder.buildPayload()`, `ServerForwarder.forward()`, `PayloadMeta`, `DailyHealthData`
- Produces: `ServerForwarder.forwardChunked(context, url, days, meta, chunkDays): Result<Unit>`, `ServerForwarder.PayloadTooLargeException`

- [ ] **Step 1: Write chunking unit test**

Create `android/app/src/test/java/com/android/vitalix/ChunkingTest.kt`:

```kotlin
package com.android.vitalix

import com.android.vitalix.models.DailyHealthData
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ChunkingTest {

    private fun fakeDays(n: Int): List<DailyHealthData> = (1..n).map { day ->
        DailyHealthData(date = "2026-08-0${day.coerceAtMost(9)}")
    }

    @Test
    fun `splitIntoChunks splits evenly`() {
        val days = fakeDays(14)
        val chunks = ServerForwarder.splitIntoChunks(days, 7)
        assertEquals(2, chunks.size)
        assertEquals(7, chunks[0].size)
        assertEquals(7, chunks[1].size)
    }

    @Test
    fun `splitIntoChunks handles remainder`() {
        val days = fakeDays(10)
        val chunks = ServerForwarder.splitIntoChunks(days, 7)
        assertEquals(2, chunks.size)
        assertEquals(7, chunks[0].size)
        assertEquals(3, chunks[1].size)
    }

    @Test
    fun `splitIntoChunks single day stays single`() {
        val days = fakeDays(1)
        val chunks = ServerForwarder.splitIntoChunks(days, 7)
        assertEquals(1, chunks.size)
        assertEquals(1, chunks[0].size)
    }

    @Test
    fun `splitIntoChunks empty list returns empty`() {
        val chunks = ServerForwarder.splitIntoChunks(emptyList(), 7)
        assertTrue(chunks.isEmpty())
    }

    @Test
    fun `buildPayload includes chunk metadata`() {
        val days = fakeDays(2)
        val meta = PayloadMeta("1.0", "test", 2)
        val json = ServerForwarder.buildPayload(days, meta, chunkIndex = 1, chunkTotal = 3)
        assertTrue(json.contains("\"chunk\""))
        assertTrue(json.contains("\"index\":1"))
        assertTrue(json.contains("\"total\":3"))
    }

    @Test
    fun `buildPayload omits chunk metadata when not chunked`() {
        val days = fakeDays(2)
        val meta = PayloadMeta("1.0", "test", 2)
        val json = ServerForwarder.buildPayload(days, meta)
        assertTrue(!json.contains("\"chunk\""))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd android
./gradlew testProductionDebugUnitTest --tests "com.android.vitalix.ChunkingTest" 2>&1 | tail -20
```

Expected: FAIL — `splitIntoChunks` and chunk-aware `buildPayload` don't exist yet.

- [ ] **Step 3: Add splitIntoChunks and chunk-aware buildPayload to ServerForwarder**

In `android/app/src/main/java/com/android/vitalix/ServerForwarder.kt`:

Add `PayloadTooLargeException` next to existing `HttpException` (after line 114):

```kotlin
    class PayloadTooLargeException(val code: Int = 413) : Exception("Server rejected payload: HTTP $code")
```

Add `splitIntoChunks` as a companion-like function (public for testing). Add it right after the `JSON` val (after line 26):

```kotlin
    const val DEFAULT_CHUNK_DAYS = 7
    const val MAX_PAYLOAD_BYTES = 512 * 1024 // 512 KB

    fun splitIntoChunks(days: List<DailyHealthData>, chunkSize: Int): List<List<DailyHealthData>> {
        if (days.isEmpty()) return emptyList()
        return days.chunked(chunkSize.coerceAtLeast(1))
    }
```

Modify `buildPayload` signature to accept optional chunk metadata (add default params so existing callers don't break):

```kotlin
    fun buildPayload(
        days: List<DailyHealthData>,
        meta: PayloadMeta,
        chunkIndex: Int? = null,
        chunkTotal: Int? = null,
    ): String {
```

Inside `buildPayload`, after `root.put("rangeDays", meta.rangeDays)` (line 62) and before `meta.profileHeightM`, add:

```kotlin
        if (chunkIndex != null && chunkTotal != null) {
            root.put("chunk", JSONObject().apply {
                put("index", chunkIndex)
                put("total", chunkTotal)
            })
        }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd android
./gradlew testProductionDebugUnitTest --tests "com.android.vitalix.ChunkingTest" 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 5: Add forwardChunked method to ServerForwarder**

Add after the existing `forward()` method (after line 112):

```kotlin
    suspend fun forwardChunked(
        context: Context,
        url: String,
        days: List<DailyHealthData>,
        meta: PayloadMeta,
        chunkDays: Int = DEFAULT_CHUNK_DAYS,
    ): Result<Unit> {
        val chunks = splitIntoChunks(days, chunkDays)
        if (chunks.isEmpty()) return Result.success(Unit)

        val total = chunks.size
        for ((i, chunk) in chunks.withIndex()) {
            val json = buildPayload(chunk, meta, chunkIndex = i + 1, chunkTotal = total)
            val bytes = json.toByteArray()

            // Tier 2: if a chunk exceeds MAX_PAYLOAD_BYTES, sub-split it
            if (bytes.size > MAX_PAYLOAD_BYTES && chunk.size > 1) {
                val subResult = forwardChunked(context, url, chunk, meta, (chunk.size / 2).coerceAtLeast(1))
                if (subResult.isFailure) return subResult
                continue
            }

            // Single-day escape hatch: send even if over size limit
            if (bytes.size > MAX_PAYLOAD_BYTES) {
                android.util.Log.w("ServerForwarder", "Single day exceeds ${MAX_PAYLOAD_BYTES}B (${bytes.size}B), sending anyway")
            }

            val result = forward(context, url, json)
            if (result.isFailure) {
                val err = result.exceptionOrNull()
                if (err is HttpException && err.code == 413) {
                    throw PayloadTooLargeException(err.code)
                }
                return Result.failure(err ?: Exception("Unknown error"))
            }
        }
        return Result.success(Unit)
    }
```

- [ ] **Step 6: Update ExportWorker to use forwardChunked**

In `android/app/src/main/java/com/android/vitalix/ExportWorker.kt`, replace lines 45-46:

```kotlin
            val json = ServerForwarder.buildPayload(days, meta)
            ServerForwarder.forward(applicationContext, url, json).fold(
```

With:

```kotlin
            ServerForwarder.forwardChunked(applicationContext, url, days, meta).fold(
                onSuccess = {
```

And update the `onSuccess` lambda — `Result<Unit>` has no status code, so remove `result.getOrNull()`:

The `onSuccess` block stays the same except its parameter is `Unit` not `Int`. And wrap the entire try block to catch `PayloadTooLargeException`:

Replace the `onFailure` handler (lines 58-69) to also handle 413:

```kotlin
                onFailure = { e ->
                    log.finish(runId, SyncLog.Status.FAILED, message = e.message)
                    when {
                        e is ServerForwarder.PayloadTooLargeException -> {
                            // Payload too large even after chunking — unrecoverable for this data range
                            Result.failure()
                        }
                        e is ServerForwarder.HttpException && e.code == 401 -> Result.failure()
                        e is ServerForwarder.HttpException && e.code in 400..499 -> Result.failure()
                        else -> Result.retry()
                    }
                }
```

- [ ] **Step 7: Update BackfillWorker to handle 413**

In `android/app/src/main/java/com/android/vitalix/BackfillWorker.kt`, replace the forward call block (lines 116-133). Replace `ServerForwarder.buildPayload` + `ServerForwarder.forward` with `ServerForwarder.forwardChunked`:

```kotlin
                    val result = try {
                        ServerForwarder.forwardChunked(
                            ctx, url, days,
                            PayloadMeta(appVersion(), Build.MODEL, WINDOW_DAYS.toInt())
                        )
                    } catch (e: ServerForwarder.PayloadTooLargeException) {
                        val detail = "Payload too large for server even after chunking"
                        log.finish(runId, SyncLog.Status.FAILED, days = daysSent, message = detail)
                        return Result.failure(message("Stopped after $daysSent days: $detail"))
                    }
                    if (result.isFailure) {
                        val err = result.exceptionOrNull()
                        val detail = when {
                            err is ServerForwarder.HttpException && err.code == 401 ->
                                "session expired — sign in again"
                            err is ServerForwarder.HttpException -> "HTTP ${err.code}"
                            else -> err?.message ?: "unknown error"
                        }
                        log.finish(runId, SyncLog.Status.FAILED, days = daysSent, message = detail)
                        return Result.failure(message("Stopped after $daysSent days: $detail"))
                    }
```

- [ ] **Step 8: Update MainActivity manual sync to use forwardChunked**

In `android/app/src/main/java/com/android/vitalix/MainActivity.kt`, in the `runSync()` method, replace the payload build + forward block (lines 655-665):

```kotlin
                    val days = healthConnectManager.readHealthDataByDay(cfg)
                    daysSent = days.size
                    ServerForwarder.forwardChunked(
                        this@MainActivity, url, days,
                        PayloadMeta(
                            appVersion = appVersion,
                            device = Build.MODEL,
                            rangeDays = cfg.daysBack,
                            profileHeightM = settings.userHeightCm?.let { it / 100.0 },
                            bmiScale = settings.resolvedBmiScale(),
                        )
                    )
```

The `result` is now `Result<Unit>` instead of `Result<Int>`. Update the success status message (line 680) — remove `result.getOrNull()`:

```kotlin
                        if (missed.isEmpty()) "Sent"
```

Also wrap the try block to catch `PayloadTooLargeException` and show it as a status:

```kotlin
            } catch (e: ServerForwarder.PayloadTooLargeException) {
                syncLog.finish(runId, SyncLog.Status.FAILED, message = "Payload too large for server")
                showStatus("Failed: payload too large even after chunking")
```

- [ ] **Step 9: Run all unit tests**

```bash
cd android
./gradlew testProductionDebugUnitTest 2>&1 | tail -20
```

Expected: all tests PASS including ChunkingTest.

- [ ] **Step 10: Commit**

```bash
git add android/app/src/main/java/com/android/vitalix/ServerForwarder.kt \
  android/app/src/main/java/com/android/vitalix/ExportWorker.kt \
  android/app/src/main/java/com/android/vitalix/BackfillWorker.kt \
  android/app/src/main/java/com/android/vitalix/MainActivity.kt \
  android/app/src/test/java/com/android/vitalix/ChunkingTest.kt
git commit -m "fix: add HTTP payload chunking to prevent 413 errors

ServerForwarder.forwardChunked() splits days into 7-day chunks.
If a chunk exceeds 512KB, it halves recursively. Single-day payloads
that still exceed the limit are sent with a warning.
ExportWorker, BackfillWorker, and manual sync all use forwardChunked().
PayloadTooLargeException surfaces 413 as a distinct error."
```

---

### Task 4: QR Code in Invite Email

Add a QR code image of the download URL to the invite email template.

**Files:**
- Modify: `web/package.json` (add `qrcode` dependency)
- Modify: `web/src/auth/emailTemplates.js:1-78` (make `inviteEmail` async, generate QR)
- Modify: `web/src/routes/admin.js:11-17,67-77` (await `inviteEmail()`)

**Interfaces:**
- Consumes: `downloadUrl` from `getInstallUrl()` (existing)
- Produces: invite email with embedded QR code PNG as base64 data URI

- [ ] **Step 1: Install qrcode npm package**

```bash
cd web
npm install qrcode
```

- [ ] **Step 2: Make inviteEmail async and add QR generation**

In `web/src/auth/emailTemplates.js`, add import at top:

```javascript
import QRCode from "qrcode";
```

Change `inviteEmail` from sync to async (line 53). Replace the function:

```javascript
export async function inviteEmail({ code, link, downloadUrl }) {
  let downloadBlock = "";
  if (downloadUrl) {
    let qrImg = "";
    try {
      const qrDataUri = await QRCode.toDataURL(downloadUrl, { width: 150, margin: 1 });
      qrImg = `<div style="text-align:center;margin:16px 0 0;">
        <img src="${qrDataUri}" alt="Scan to download Vitalix" width="150" height="150" style="border:1px solid #e0e0e0;border-radius:4px;" />
        <p style="font-size:12px;color:#8e99a4;margin:4px 0 0;">Scan to download</p>
      </div>`;
    } catch (_) { /* QR generation failed — text link is the fallback */ }
    downloadBlock = `<p style="margin:16px 0 0;font-size:14px;color:#5a6570;">
        <a href="${downloadUrl}" style="color:#0FA9A0;font-weight:600;text-decoration:none;">Download the Vitalix app &darr;</a>
      </p>${qrImg}`;
  }
  return {
    html: layout(`
      <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#0E1B2B;letter-spacing:-0.3px;">You're invited</h1>
      <p style="margin:0 0 0;font-size:15px;color:#5a6570;line-height:1.6;">
        Someone invited you to join Vitalix. Create your account to get started.
      </p>
      ${button(link, "Create your account")}
      ${divider()}
      <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#8e99a4;text-transform:uppercase;letter-spacing:0.8px;">Invite code</p>
      <table cellpadding="0" cellspacing="0" role="presentation"><tr>
        <td style="background:#f0fdfa;border:1px solid #d1fae5;border-radius:8px;padding:12px 20px;">
          <span style="font-family:'Courier New',monospace;font-size:22px;font-weight:700;letter-spacing:3px;color:#0d9488;">${code}</span>
        </td>
      </tr></table>
      ${downloadBlock}
      <p style="margin:28px 0 0;font-size:12px;color:#8e99a4;">This invite expires in 7 days.</p>
    `),
    text: `You're invited to Vitalix!\n\nYour invite code: ${code}\n\nSign up: ${link}\n${downloadUrl ? `\nDownload the app: ${downloadUrl}\n` : ""}\nExpires in 7 days.`,
  };
}
```

- [ ] **Step 3: Update admin.js to await inviteEmail**

In `web/src/routes/admin.js`, line 17 — `inviteEmail()` is now async. Update:

```javascript
  await sendMail(email, "You're invited to Vitalix", await inviteEmail({ code: raw, link, downloadUrl }));
```

Similarly, line 75:

```javascript
  await sendMail(invite.email, "You're invited to Vitalix", await inviteEmail({ code: raw, link, downloadUrl }));
```

- [ ] **Step 4: Test by sending an invite email**

Start the web server locally and send a test invite via the admin UI or curl:

```bash
cd web
npm start &
curl -X POST http://localhost:3000/api/admin/invites \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin_token>" \
  -d '{"email": "test@example.com"}'
```

Check console output (if SMTP not configured, mailer logs the email). Verify the HTML contains a `data:image/png;base64` img tag.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/src/auth/emailTemplates.js web/src/routes/admin.js
git commit -m "feat: add QR code to invite email download link

qrcode package generates a PNG data URI embedded in the invite
email HTML. Falls back gracefully if QR generation fails — the
text download link remains."
```

---

### Task 5: Zealot SDK + In-App Update + FCM Webhook

Wire Zealot SDK for manual update checks, implement `UpdateManager` for in-app APK download/install, add web webhook endpoint for Zealot → FCM push, and flesh out `VitalixFirebaseService` to handle update notifications.

**Files:**
- Modify: `android/gradle/libs.versions.toml` (add zealot-android)
- Modify: `android/app/build.gradle.kts` (add zealot dependency, add maven repo)
- Create: `android/app/src/main/java/com/android/vitalix/UpdateManager.kt`
- Create: `android/app/src/main/res/xml/file_provider_paths.xml`
- Modify: `android/app/src/main/AndroidManifest.xml` (add permission + FileProvider)
- Modify: `android/app/src/main/java/com/android/vitalix/VitalixFirebaseService.kt` (handle update notifications)
- Modify: `android/app/src/main/java/com/android/vitalix/VitalixApp.kt` (init Zealot)
- Modify: `android/app/src/main/java/com/android/vitalix/MainActivity.kt` (check for updates, handle notification intent)
- Create: `web/src/firebase.js` (Firebase Admin init)
- Create: `web/src/routes/webhooks.js` (Zealot webhook handler)
- Modify: `web/src/config.js` (add firebase + webhook config)
- Modify: `web/src/index.js` (register webhook router)
- Modify: `web/package.json` (add firebase-admin)
- Create: `web/migrations/<timestamp>_fcm_tokens.cjs` (fcm_tokens table)

**Interfaces:**
- Consumes: `BuildConfig.ZEALOT_ENDPOINT`, `BuildConfig.ZEALOT_CHANNEL_KEY` from Task 1. `VitalixFirebaseService` from Task 2.
- Produces: Full update flow: Zealot SDK check → update dialog → download → install. FCM webhook → push notification → notification tap → download → install.

- [ ] **Step 1: Add Zealot SDK dependency**

The Zealot Android SDK is published as `com.github.nichenqin:zealot-android` on JitPack. In `android/gradle/libs.versions.toml`, add to `[versions]`:

```toml
zealot = "0.4.0"
```

Add to `[libraries]`:

```toml
zealot-android = { group = "com.github.nichenqin", name = "zealot-android", version.ref = "zealot" }
```

In `android/settings.gradle.kts` (or `android/build.gradle.kts` project-level), add JitPack repository if not present:

```kotlin
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven { url = uri("https://jitpack.io") }
    }
}
```

In `android/app/build.gradle.kts` dependencies:

```kotlin
implementation(libs.zealot.android)
```

**Note:** Verify the exact Zealot SDK package name and version from https://zealot.ews.im/docs/developer-guide/sdk/android before implementing. The package name above is a placeholder based on common JitPack patterns — the actual SDK may be published differently.

- [ ] **Step 2: Create file_provider_paths.xml**

Create `android/app/src/main/res/xml/file_provider_paths.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<paths>
    <external-path name="downloads" path="Download/" />
</paths>
```

- [ ] **Step 3: Update AndroidManifest.xml**

Add permissions before the `<application>` tag:

```xml
    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
```

Inside the `<application>` tag, add the FileProvider:

```xml
        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_provider_paths" />
        </provider>
```

- [ ] **Step 4: Create UpdateManager**

Create `android/app/src/main/java/com/android/vitalix/UpdateManager.kt`:

```kotlin
package com.android.vitalix

import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider

class UpdateManager(private val context: Context) {

    private var downloadId: Long = -1

    fun downloadAndInstall(downloadUrl: String, version: String) {
        ensureChannel()

        val request = DownloadManager.Request(Uri.parse(downloadUrl))
            .setTitle("Vitalix $version")
            .setDescription("Downloading update…")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "vitalix-$version.apk")

        val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        downloadId = dm.enqueue(request)
        Log.d(TAG, "Download enqueued: id=$downloadId url=$downloadUrl")

        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
                if (id != downloadId) return
                context.unregisterReceiver(this)
                onDownloadComplete(dm, id)
            }
        }
        ContextCompat.registerReceiver(
            context, receiver,
            IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
    }

    private fun onDownloadComplete(dm: DownloadManager, id: Long) {
        val uri = dm.getUriForDownloadedFile(id) ?: run {
            Log.e(TAG, "Download failed — no URI for id=$id")
            return
        }
        Log.d(TAG, "Download complete: $uri")
        promptInstall(uri)
    }

    private fun promptInstall(apkUri: Uri) {
        val install = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(apkUri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(install)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    companion object {
        private const val TAG = "UpdateManager"
        const val CHANNEL = "vitalix_updates"
        const val EXTRA_DOWNLOAD_URL = "update_download_url"
        const val EXTRA_VERSION = "update_version"
    }
}
```

- [ ] **Step 5: Update VitalixFirebaseService to handle update notifications**

Replace `android/app/src/main/java/com/android/vitalix/VitalixFirebaseService.kt`:

```kotlin
package com.android.vitalix

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class VitalixFirebaseService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        Log.d(TAG, "FCM token refreshed")
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        Log.d(TAG, "FCM message received: type=${data["type"]}")

        if (data["type"] == "app_update") {
            val version = data["version"] ?: "new version"
            val downloadUrl = data["download_url"] ?: return
            showUpdateNotification(version, downloadUrl)
        }
    }

    private fun showUpdateNotification(version: String, downloadUrl: String) {
        ensureChannel()
        val intent = Intent(this, MainActivity::class.java).apply {
            putExtra(UpdateManager.EXTRA_DOWNLOAD_URL, downloadUrl)
            putExtra(UpdateManager.EXTRA_VERSION, version)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, UpdateManager.CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("Vitalix Update Available")
            .setContentText("Version $version is ready to install")
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID, notification)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(UpdateManager.CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT)
            )
        }
    }

    companion object {
        private const val TAG = "VitalixFCM"
        private const val NOTIFICATION_ID = 4300
    }
}
```

- [ ] **Step 6: Initialize Zealot SDK in VitalixApp**

Update `android/app/src/main/java/com/android/vitalix/VitalixApp.kt`:

```kotlin
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

        // Zealot SDK initialization — check for updates is done in MainActivity
        // The SDK uses BuildConfig.ZEALOT_ENDPOINT and BuildConfig.ZEALOT_CHANNEL_KEY
    }
}
```

**Note:** The exact Zealot SDK initialization API should be verified from the Zealot docs. Some versions use `Zealot.initialize(context, endpoint, channelKey)`, others use a builder. Adapt accordingly at implementation time.

- [ ] **Step 7: Add update check to MainActivity**

In `android/app/src/main/java/com/android/vitalix/MainActivity.kt`, at the end of `onCreate()` (after `btnSyncNow.setOnClickListener`, around line 183), add:

```kotlin
        handleUpdateIntent(intent)
```

Add the handler method:

```kotlin
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleUpdateIntent(intent)
    }

    private fun handleUpdateIntent(intent: Intent?) {
        val downloadUrl = intent?.getStringExtra(UpdateManager.EXTRA_DOWNLOAD_URL) ?: return
        val version = intent.getStringExtra(UpdateManager.EXTRA_VERSION) ?: "update"
        intent.removeExtra(UpdateManager.EXTRA_DOWNLOAD_URL)
        UpdateManager(this).downloadAndInstall(downloadUrl, version)
    }
```

For the manual Zealot check on app open, add after `handleUpdateIntent(intent)`:

```kotlin
        // Check Zealot for updates on app open.
        // The exact API depends on the Zealot SDK version — verify from
        // https://zealot.ews.im/docs/developer-guide/sdk/android
        // Common patterns:
        //   Zealot.checkForUpdates(this)
        //   Zealot.create(this).check()
        // If the SDK shows its own dialog, no UpdateManager call is needed here.
        // If it returns a result, pass the download URL to UpdateManager.
        if (BuildConfig.ZEALOT_ENDPOINT.isNotBlank()) {
            // Zealot.checkForUpdates(this)
        }
```

- [ ] **Step 8: Create web-side Firebase Admin initialization**

Install firebase-admin:

```bash
cd web
npm install firebase-admin
```

Create `web/src/firebase.js`:

```javascript
import admin from "firebase-admin";

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (serviceAccountJson) {
  try {
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } catch (e) {
    console.warn("Firebase Admin init failed:", e.message);
  }
} else {
  console.warn("FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled");
}

export { admin };
```

- [ ] **Step 9: Add webhook config to web config.js**

In `web/src/config.js`, add these fields to the `config` object (after line 28, `zealotChannelKey`):

```javascript
  zealotWebhookSecret: process.env.ZEALOT_WEBHOOK_SECRET || null,
  firebaseEnabled: !!process.env.FIREBASE_SERVICE_ACCOUNT,
```

- [ ] **Step 10: Create fcm_tokens migration**

Create `web/migrations/1722600000000_fcm_tokens.cjs`:

```javascript
exports.up = (pgm) => {
  pgm.createTable("fcm_tokens", {
    id: "id",
    user_id: {
      type: "integer",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    token: { type: "text", notNull: true, unique: true },
    app_id: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("fcm_tokens", "user_id");
};

exports.down = (pgm) => {
  pgm.dropTable("fcm_tokens");
};
```

- [ ] **Step 11: Create Zealot webhook route**

Create `web/src/routes/webhooks.js`:

```javascript
import { Router } from "express";
import { config } from "../config.js";
import { admin } from "../firebase.js";

export const webhookRouter = Router();

webhookRouter.post("/api/webhooks/zealot", async (req, res) => {
  const token = req.headers["x-zealot-token"];
  if (!config.zealotWebhookSecret || token !== config.zealotWebhookSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { event, data } = req.body || {};
  if (event === "upload_events" && data) {
    const { bundle_id, release_version, install_url } = data;
    if (config.firebaseEnabled && install_url) {
      const topic = bundle_id?.includes(".beta") ? "app-updates-beta" : "app-updates";
      try {
        await admin.messaging().send({
          topic,
          notification: {
            title: "Vitalix Update Available",
            body: `Version ${release_version || "new"} is ready to install`,
          },
          data: {
            type: "app_update",
            version: release_version || "",
            download_url: install_url,
          },
        });
        console.log(`FCM sent to topic=${topic} version=${release_version}`);
      } catch (e) {
        console.error("FCM send failed:", e.message);
      }
    }
  }

  res.status(200).json({ ok: true });
});
```

- [ ] **Step 12: Register webhook router in index.js**

In `web/src/index.js`, add import and use:

```javascript
import { webhookRouter } from "./routes/webhooks.js";
```

Add before `app.listen`:

```javascript
app.use(webhookRouter);
```

- [ ] **Step 13: Verify Android build**

```bash
cd android
./gradlew assembleProductionDebug assembleBetaDebug
```

Expected: both variants build successfully with Zealot SDK and Firebase.

- [ ] **Step 14: Verify web server starts**

```bash
cd web
npm start
```

Expected: server starts. If `FIREBASE_SERVICE_ACCOUNT` not set, should log warning but not crash.

- [ ] **Step 15: Run web migration**

```bash
cd web
npx node-pg-migrate up
```

Expected: `fcm_tokens` table created.

- [ ] **Step 16: Commit**

```bash
git add android/gradle/libs.versions.toml android/app/build.gradle.kts \
  android/app/src/main/java/com/android/vitalix/UpdateManager.kt \
  android/app/src/main/java/com/android/vitalix/VitalixFirebaseService.kt \
  android/app/src/main/java/com/android/vitalix/VitalixApp.kt \
  android/app/src/main/java/com/android/vitalix/MainActivity.kt \
  android/app/src/main/res/xml/file_provider_paths.xml \
  android/app/src/main/AndroidManifest.xml \
  web/src/firebase.js web/src/routes/webhooks.js web/src/config.js \
  web/src/index.js web/package.json web/package-lock.json \
  web/migrations/1722600000000_fcm_tokens.cjs
git commit -m "feat: Zealot in-app updates + FCM webhook notification

Android: UpdateManager downloads APK via DownloadManager and prompts
install. VitalixFirebaseService shows notification on FCM push,
tapping it triggers download. Zealot SDK wired for manual check.

Web: /api/webhooks/zealot receives Zealot upload events and sends
FCM topic push via firebase-admin. fcm_tokens table added for
future per-user notifications."
```

---

## Verification Checklist

After all tasks are complete, verify end-to-end:

- [ ] Both `productionDebug` and `betaDebug` APKs build with distinct applicationIds
- [ ] Fastlane `beta` lane produces `betaRelease` APK, `production` lane produces `productionRelease` APK
- [ ] Manual sync with a large date range does not produce 413 — payload is chunked
- [ ] Invite email contains QR code image that scans to the Zealot download URL
- [ ] Web server starts with Firebase Admin SDK (when `FIREBASE_SERVICE_ACCOUNT` is set)
- [ ] `POST /api/webhooks/zealot` with valid token sends FCM notification
- [ ] Android app receives FCM push and shows update notification
- [ ] Tapping notification downloads APK and prompts install
