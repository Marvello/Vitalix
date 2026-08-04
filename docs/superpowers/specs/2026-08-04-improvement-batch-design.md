# Improvement Batch Design Spec

**Date:** 2026-08-04
**Source:** `docs/feature-request/03-improvement.md`
**Status:** Draft

## Overview

Five items from feature request 03, organized into four implementation phases with shared infrastructure dependencies. Covers a bug fix (413 chunking), email enhancement (QR code), build restructuring (product flavors), and a new subsystem (Firebase + Zealot in-app updates).

## Phase 1: Firebase SDK + Product Flavors (Foundation)

Everything in Phase 4 depends on Firebase being wired. Product flavors are a build-config restructure best done early before other changes layer on top.

### 1.1 Product Flavors

Replace current build-type-based beta separation with proper product flavors.

**Current state:** `beta` build type with `applicationIdSuffix = ".beta"` and separate signing config. This works but conflates environment (beta/prod) with build type (debug/release).

**Target state:**

```kotlin
flavorDimensions += "environment"
productFlavors {
    create("production") {
        dimension = "environment"
        applicationId = "com.android.vitalix"
        resValue("string", "app_name", "Vitalix")
    }
    create("beta") {
        dimension = "environment"
        applicationId = "com.android.vitalix.beta"
        resValue("string", "app_name", "Vitalix Beta")
    }
}
```

**Build variants produced:** `productionDebug`, `productionRelease`, `betaDebug`, `betaRelease`.

**Changes required:**

| Area | Change |
|---|---|
| `build.gradle.kts` | Add `flavorDimensions` + `productFlavors` block. Remove `applicationIdSuffix` and `versionNameSuffix` from old `beta` build type. Move beta signing config to `productionRelease`/`betaRelease` via `buildTypes` + `productFlavors` combination. |
| `src/beta/res/` | New source set with beta launcher icon (tinted or badged variant of production icon). |
| `src/production/res/` | Production launcher icon (current default). |
| `AndroidManifest.xml` | Use `@string/app_name` (already the case) — flavor `resValue` overrides it. |
| Fastlane | Update lanes to build `assembleBetaRelease` and `assembleProductionRelease` instead of `assembleBeta` and `assembleRelease`. |
| `buildConfigField` | Add per-flavor `ZEALOT_CHANNEL_KEY` so the correct Zealot channel is used per environment (see Phase 4). |

### 1.2 Firebase SDK

**Current state:** `google-services.json` exists with both `com.android.vitalix` and `com.android.vitalix.beta` registered in Firebase project `vitalix-96fcb`. Plugin and dependencies are not wired.

**Changes required:**

| Area | Change |
|---|---|
| `libs.versions.toml` | Add: `googleServices = "4.5.0"`, `firebaseMessaging = "24.1.0"` (or latest stable at implementation time). Add plugin alias `google-services`. Add library alias `firebase-messaging`. |
| Project-level `build.gradle.kts` | Apply `com.google.gms.google-services` plugin (with `apply false`). |
| App-level `build.gradle.kts` | Apply `com.google.gms.google-services` plugin. Add `firebase-messaging` dependency. |
| `VitalixFirebaseService.kt` | New class extending `FirebaseMessagingService`. Handles `onNewToken()` (sends token to server) and `onMessageReceived()` (shows update notification). |
| `AndroidManifest.xml` | Register `VitalixFirebaseService` with `<intent-filter>` for `com.google.firebase.MESSAGING_EVENT`. |
| App startup | Subscribe to FCM topic `app-updates` via `FirebaseMessaging.getInstance().subscribeToTopic("app-updates")`. |

### 1.3 FCM Token Registration

On token refresh or first launch, POST token to web server:

```
POST /api/devices/register
Authorization: Bearer <access_token>
{
  "fcm_token": "<token>",
  "app_id": "com.android.vitalix" | "com.android.vitalix.beta"
}
```

Server stores in new `fcm_tokens` table:

```sql
CREATE TABLE fcm_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    app_id TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
```

Topic-based FCM handles broadcast (update notifications). Individual tokens reserved for future user-specific notifications.

---

## Phase 2: Payload Chunking Fix (Bug Fix)

### Problem

`ServerForwarder.forward()` sends entire `List<DailyHealthData>` as a single HTTP POST. Users with weeks of high-frequency samples (continuous heart rate, GPS routes) produce payloads that exceed server body limits, resulting in HTTP 413.

Current error handling treats 413 as generic 4xx failure — no retry, no split.

### Solution: Two-Tier Chunking

**Tier 1 — Day-based splitting:**

New method `ServerForwarder.forwardChunked()`:

```kotlin
suspend fun forwardChunked(
    context: Context,
    url: String,
    days: List<DailyHealthData>,
    meta: PayloadMeta,
    chunkDays: Int = DEFAULT_CHUNK_DAYS  // 7
): Result<Unit>
```

Splits `days` into chunks of `chunkDays`. Each chunk gets its own `buildPayload()` + `forward()` call. Meta includes chunk index: `{ "chunk": { "index": 1, "total": 3 } }`.

**Tier 2 — Size fallback:**

Before sending each chunk, measure `json.toByteArray().size`. If exceeds `MAX_PAYLOAD_BYTES` (512 KB), halve the chunk and retry. Recurse until under threshold or single day.

**Single-day escape hatch:** If one day alone exceeds the limit, send it anyway. Log a warning. No infinite recursion.

**New exception:**

```kotlin
class PayloadTooLargeException(val code: Int = 413) : Exception("Server rejected payload: $code")
```

**ExportWorker changes:**
- Call `forwardChunked()` instead of `forward()`
- Catch `PayloadTooLargeException` → retry with halved chunk size
- If chunk size reaches 1 day and still 413 → log error, mark sync as failed

**BackfillWorker changes:**
- Add same 413 detection within existing 30-day window loop
- On 413, sub-split current window and retry

### Server side

No changes required. Server's existing body-size limit (express default or nginx) is the trigger. Chunking is purely client-side.

---

## Phase 3: QR Code in Invite Email

### Implementation

**New dependency:** `qrcode` npm package (v1.x, MIT license, pure JS, no native deps).

**Changes to `web/src/auth/emailTemplates.js`:**

`inviteEmail()` becomes `async` (QR generation is async). When `downloadUrl` is present:

```javascript
const QRCode = require('qrcode');
const qrDataUri = await QRCode.toDataURL(downloadUrl, { width: 150, margin: 1 });
```

Embed in HTML template below existing download link:

```html
<div style="text-align: center; margin: 16px 0;">
  <img src="${qrDataUri}" alt="Scan to download Vitalix"
       width="150" height="150" style="border: 1px solid #e0e0e0;" />
  <p style="font-size: 12px; color: #666; margin-top: 4px;">Scan to download</p>
</div>
```

**Callers updated:** `admin.js` routes that call `inviteEmail()` must `await` it.

**Plain-text version:** Unchanged — URL is already included as text.

**Fallback:** Some older email clients may not render base64 data URIs. The text download link above the QR serves as fallback. No functional loss.

---

## Phase 4: Zealot In-App Updates + FCM Webhook

### 4.1 Zealot SDK Integration (Android)

**Dependency:** Add Zealot Android SDK to version catalog and `build.gradle.kts`.

**Initialization:** Create `VitalixApp` application class (or extend existing) to initialize Zealot SDK:

```kotlin
class VitalixApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Zealot.initialize(this, BuildConfig.ZEALOT_ENDPOINT, BuildConfig.ZEALOT_CHANNEL_KEY)
    }
}
```

`ZEALOT_ENDPOINT` and `ZEALOT_CHANNEL_KEY` are `buildConfigField` values set per product flavor in `build.gradle.kts`.

**Manual check on app open:** In `MainActivity.onCreate()`:

```kotlin
Zealot.checkForUpdates(this) // SDK shows dialog if update available
```

### 4.2 UpdateManager (Android)

New class handling the download-and-install flow when an update is confirmed (either from Zealot SDK dialog or FCM notification tap).

```kotlin
class UpdateManager(private val context: Context) {
    fun downloadAndInstall(downloadUrl: String)
    // Uses DownloadManager to download APK
    // BroadcastReceiver for ACTION_DOWNLOAD_COMPLETE
    // Creates install intent via FileProvider + ACTION_INSTALL_PACKAGE
}
```

**Manifest additions:**

```xml
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />

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

`file_provider_paths.xml`:
```xml
<paths>
    <external-path name="downloads" path="Download/" />
</paths>
```

**Download flow:**
1. `DownloadManager.enqueue()` with APK URL
2. Show progress notification (reuse existing notification channel or create `updates` channel)
3. On `ACTION_DOWNLOAD_COMPLETE`, get downloaded file URI
4. Create `ACTION_INSTALL_PACKAGE` intent with `FileProvider.getUriForFile()`
5. Start install activity

### 4.3 FCM Notification Handling (Android)

`VitalixFirebaseService.onMessageReceived()`:

```kotlin
override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    if (data["type"] == "app_update") {
        val version = data["version"]
        val downloadUrl = data["download_url"]
        showUpdateNotification(version, downloadUrl)
    }
}
```

Notification tap opens `MainActivity` with an intent extra that triggers `UpdateManager.downloadAndInstall()`.

### 4.4 Zealot Webhook Endpoint (Web Server)

**New route:** `POST /api/webhooks/zealot`

```javascript
router.post('/api/webhooks/zealot', async (req, res) => {
    const token = req.headers['x-zealot-token'];
    if (token !== config.zealotWebhookSecret) return res.status(401).end();

    const { event, data } = req.body;
    // Zealot webhook event name — verify from Zealot admin webhook config
    if (event === 'upload_events') {
        const { app_name, bundle_id, release_version, install_url } = data;
        await sendFcmUpdateNotification(release_version, install_url, bundle_id);
    }
    res.status(200).end();
});
```

**FCM send function:**

```javascript
const admin = require('firebase-admin');

async function sendFcmUpdateNotification(version, downloadUrl, bundleId) {
    const topic = bundleId.includes('.beta') ? 'app-updates-beta' : 'app-updates';
    await admin.messaging().send({
        topic,
        notification: {
            title: 'Vitalix Update Available',
            body: `Version ${version} is ready to install`
        },
        data: {
            type: 'app_update',
            version,
            download_url: downloadUrl
        }
    });
}
```

**Topic separation:** `app-updates` for production, `app-updates-beta` for beta. Android app subscribes to the correct topic based on `BuildConfig.APPLICATION_ID`.

### 4.5 Firebase Admin Setup (Web Server)

**New dependency:** `firebase-admin` npm package.

**Initialization in `web/src/config.js` or new `web/src/firebase.js`:**

```javascript
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
```

**Environment variables:**
- `FIREBASE_SERVICE_ACCOUNT` — JSON string of Firebase service account credentials
- `ZEALOT_WEBHOOK_SECRET` — shared secret for webhook authentication

### 4.6 Data Flow

```
Fastlane uploads APK → Zealot
         │
         ├─→ Zealot webhook → POST /api/webhooks/zealot
         │                         │
         │                         └─→ FCM topic push → Android notification
         │                                                    │
         │                                                    └─→ User taps → UpdateManager
         │                                                                        │
         └─→ User opens app → Zealot.checkForUpdates() ─────────────────────────→ │
                                                                                   ↓
                                                                          Download APK
                                                                                   ↓
                                                                          Prompt install
```

---

## Dependencies Between Phases

```
Phase 1 (Firebase + Flavors) ──→ Phase 4 (Zealot + Updates)
                                      ↑ uses FCM + flavor build config
Phase 2 (Chunking) ── independent
Phase 3 (QR Email) ── independent
```

Phases 2 and 3 can be implemented in parallel. Phase 4 requires Phase 1.

---

## New Files Summary

| File | Phase | Purpose |
|---|---|---|
| `android/app/src/main/java/.../VitalixApp.kt` | 1, 4 | Application class for Firebase + Zealot init |
| `android/app/src/main/java/.../VitalixFirebaseService.kt` | 1 | FCM token + message handling |
| `android/app/src/main/java/.../UpdateManager.kt` | 4 | APK download + install flow |
| `android/app/src/main/res/xml/file_provider_paths.xml` | 4 | FileProvider config for APK sharing |
| `android/app/src/beta/res/` | 1 | Beta flavor resources (launcher icon) |
| `android/app/src/production/res/` | 1 | Production flavor resources |
| `web/src/firebase.js` | 1 | Firebase Admin SDK initialization |
| `web/src/routes/webhooks.js` | 4 | Zealot webhook handler |

## Modified Files Summary

| File | Phase | Change |
|---|---|---|
| `android/app/build.gradle.kts` | 1 | Product flavors, Firebase deps, Zealot SDK, buildConfigFields |
| `android/gradle/libs.versions.toml` | 1 | New version entries + plugin/library aliases |
| `android/app/src/main/AndroidManifest.xml` | 1, 4 | Firebase service, FileProvider, install permission |
| `android/app/src/main/java/.../ServerForwarder.kt` | 2 | Add `forwardChunked()`, size check, `PayloadTooLargeException` |
| `android/app/src/main/java/.../ExportWorker.kt` | 2 | Use `forwardChunked()`, handle 413 |
| `android/app/src/main/java/.../BackfillWorker.kt` | 2 | Add 413 sub-split logic |
| `android/app/src/main/java/.../MainActivity.kt` | 4 | Call `Zealot.checkForUpdates()` on startup |
| `web/src/auth/emailTemplates.js` | 3 | Add QR code generation, make `inviteEmail()` async |
| `web/src/routes/admin.js` | 3 | Await `inviteEmail()` |
| `web/src/config.js` | 4 | Add Firebase + webhook secret config |
| `web/package.json` | 3, 4 | Add `qrcode`, `firebase-admin` deps |
| `android/fastlane/Fastfile` | 1 | Update build variant names |

## Testing Strategy

| Phase | Tests |
|---|---|
| 1 | Build both flavors successfully. Verify distinct `applicationId` in each APK. Verify FCM token registration POST. |
| 2 | Unit test `forwardChunked()` with mock payloads exceeding size limit. Test 413 retry logic. Test single-day escape hatch. Integration test with large real payload. |
| 3 | Unit test QR generation produces valid data URI. Visual test: send invite email, verify QR renders and scans correctly. |
| 4 | Unit test `UpdateManager` download flow with mock DownloadManager. Integration test: upload to Zealot → verify webhook fires → verify FCM received. Manual test: full update flow on device. |
