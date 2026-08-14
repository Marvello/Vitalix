# In-App Update Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the AlertDialog update prompt with a full-screen Mihon-style UpdateActivity showing changelog, download progress bar, and install button.

**Architecture:** New `UpdateActivity` with a state machine (READY → DOWNLOADING → DOWNLOADED / ERROR). `UpdateManager` gains an `UpdateInfo` data class and progress-tracking download. `MainActivity` and `VitalixFirebaseService` route to `UpdateActivity` instead of handling updates inline.

**Tech Stack:** Android Views (XML layout), MaterialButton, LinearProgressIndicator, DownloadManager, FileProvider, OkHttp (existing), coroutines (existing)

## Global Constraints

- `minSdk 30`, `compileSdk 37`, Java 11, Kotlin
- Dependencies use `libs.*` version catalog aliases — no hardcoded versions
- View binding enabled (`viewBinding = true`)
- Brand colors: Vital Teal `#0FA9A0`, Pulse Green `#34D399`
- Theme: `Theme.Material3.DayNight.NoActionBar`
- APK package: `com.android.vitalix`
- Zealot API endpoint configured via `BuildConfig.ZEALOT_ENDPOINT` and `BuildConfig.ZEALOT_CHANNEL_KEY`

---

### Task 1: UpdateInfo data class + UpdateManager API changes

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/UpdateManager.kt`
- Test: `android/app/src/test/java/com/android/vitalix/UpdateManagerTest.kt`

**Interfaces:**
- Consumes: OkHttp `Response` from Zealot API
- Produces:
  - `data class UpdateInfo(val versionName: String, val versionCode: Int, val changelog: String, val downloadUrl: String)` — implements `Parcelable`
  - `fun checkForUpdate(endpoint: String, channelKey: String, currentVersionCode: Int, onUpdateAvailable: (UpdateInfo) -> Unit)`
  - `fun downloadApk(downloadUrl: String, versionName: String): Long` — returns DownloadManager download ID
  - `fun queryProgress(downloadId: Long): DownloadProgress` — returns `DownloadProgress(bytesDownloaded: Long, bytesTotal: Long, status: Int)`
  - `fun getApkUri(downloadId: Long): Uri?` — returns FileProvider content URI
  - `fun cancelDownload(downloadId: Long)` — removes download from DownloadManager
  - `data class DownloadProgress(val bytesDownloaded: Long, val bytesTotal: Long, val status: Int)`

- [ ] **Step 1: Write test for Zealot JSON parsing with changelog**

Create `android/app/src/test/java/com/android/vitalix/UpdateManagerTest.kt`:

```kotlin
package com.android.vitalix

import org.json.JSONObject
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class UpdateManagerTest {

    @Test
    fun `parseUpdateInfo extracts all fields from flat response`() {
        val json = JSONObject("""
            {
                "install_url": "https://zealot.example/download/42",
                "build_version": "5",
                "version": "1.2.0",
                "changelog": "### Fixes\n- Fixed date display\n- Improved sync"
            }
        """)
        val info = UpdateManager.parseUpdateInfo(json, currentVersionCode = 3)
        assertEquals("1.2.0", info!!.versionName)
        assertEquals(5, info.versionCode)
        assertEquals("### Fixes\n- Fixed date display\n- Improved sync", info.changelog)
        assertEquals("https://zealot.example/download/42", info.downloadUrl)
    }

    @Test
    fun `parseUpdateInfo falls back to releases array`() {
        val json = JSONObject("""
            {
                "install_url": "",
                "build_version": "",
                "releases": [{
                    "install_url": "https://zealot.example/download/99",
                    "build_version": "7",
                    "version": "2.0.0",
                    "changelog": "Big release"
                }]
            }
        """)
        val info = UpdateManager.parseUpdateInfo(json, currentVersionCode = 3)
        assertEquals("2.0.0", info!!.versionName)
        assertEquals(7, info.versionCode)
        assertEquals("Big release", info.changelog)
    }

    @Test
    fun `parseUpdateInfo returns null when version not newer`() {
        val json = JSONObject("""
            {
                "install_url": "https://zealot.example/download/42",
                "build_version": "3",
                "version": "1.0.0",
                "changelog": ""
            }
        """)
        val info = UpdateManager.parseUpdateInfo(json, currentVersionCode = 3)
        assertNull(info)
    }

    @Test
    fun `parseUpdateInfo returns null when download url blank`() {
        val json = JSONObject("""
            {
                "install_url": "",
                "build_version": "5",
                "version": "1.2.0",
                "changelog": "stuff"
            }
        """)
        val info = UpdateManager.parseUpdateInfo(json, currentVersionCode = 3)
        assertNull(info)
    }

    @Test
    fun `parseUpdateInfo uses build_version as fallback versionName`() {
        val json = JSONObject("""
            {
                "install_url": "https://zealot.example/download/42",
                "build_version": "5",
                "changelog": "no version field"
            }
        """)
        val info = UpdateManager.parseUpdateInfo(json, currentVersionCode = 3)
        assertEquals("5", info!!.versionName)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd android && ./gradlew testProductionDebugUnitTest --tests "com.android.vitalix.UpdateManagerTest" 2>&1 | tail -20
```

Expected: FAIL — `parseUpdateInfo` does not exist yet.

- [ ] **Step 3: Add UpdateInfo data class and parseUpdateInfo to UpdateManager**

Replace the full `UpdateManager.kt` with the updated version. Key changes:
1. Add `UpdateInfo` as a `Parcelable` data class
2. Add `DownloadProgress` data class
3. Extract `parseUpdateInfo` as a `companion object` function (testable without Context)
4. Change `checkForUpdate` callback to return `UpdateInfo` instead of just the URL
5. Replace `downloadAndInstall` with `downloadApk` (returns download ID), `queryProgress`, `getApkUri`, `cancelDownload`
6. Download to cache dir instead of public Downloads

```kotlin
package com.android.vitalix

import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Parcelable
import android.util.Log
import androidx.core.content.FileProvider
import kotlinx.parcelize.Parcelize
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException

@Parcelize
data class UpdateInfo(
    val versionName: String,
    val versionCode: Int,
    val changelog: String,
    val downloadUrl: String,
) : Parcelable

data class DownloadProgress(
    val bytesDownloaded: Long,
    val bytesTotal: Long,
    val status: Int,
)

class UpdateManager(private val context: Context) {

    private val httpClient = OkHttpClient()

    fun checkForUpdate(
        endpoint: String,
        channelKey: String,
        currentVersionCode: Int,
        onUpdateAvailable: (UpdateInfo) -> Unit
    ) {
        if (endpoint.isBlank() || channelKey.isBlank()) return

        val url = "${endpoint.trimEnd('/')}/api/apps/latest?channel_key=$channelKey"
        val request = Request.Builder().url(url).get().build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.w(TAG, "Update check failed: ${e.message}")
            }

            override fun onResponse(call: Call, response: okhttp3.Response) {
                response.use {
                    if (!it.isSuccessful) {
                        Log.w(TAG, "Update check returned ${it.code}")
                        return
                    }
                    try {
                        val body = it.body?.string() ?: return
                        val json = JSONObject(body)
                        val info = parseUpdateInfo(json, currentVersionCode)
                        if (info != null) onUpdateAvailable(info)
                    } catch (e: Exception) {
                        Log.w(TAG, "Update check parse failed: ${e.message}")
                    }
                }
            }
        })
    }

    fun downloadApk(downloadUrl: String, versionName: String): Long {
        ensureChannel()
        val apkFile = apkFile(versionName)
        if (apkFile.exists()) apkFile.delete()

        val request = DownloadManager.Request(Uri.parse(downloadUrl))
            .setTitle("Vitalix $versionName")
            .setDescription("Downloading update…")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setDestinationUri(Uri.fromFile(apkFile))

        val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val id = dm.enqueue(request)
        Log.d(TAG, "Download enqueued: id=$id url=$downloadUrl")
        return id
    }

    fun queryProgress(downloadId: Long): DownloadProgress {
        val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val query = DownloadManager.Query().setFilterById(downloadId)
        val cursor = dm.query(query)
        if (cursor == null || !cursor.moveToFirst()) {
            cursor?.close()
            return DownloadProgress(0, 0, DownloadManager.STATUS_FAILED)
        }
        val downloaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
        val total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
        val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
        cursor.close()
        return DownloadProgress(downloaded, total, status)
    }

    fun getApkUri(downloadId: Long): Uri? {
        val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val query = DownloadManager.Query().setFilterById(downloadId)
        val cursor = dm.query(query) ?: return null
        if (!cursor.moveToFirst()) { cursor.close(); return null }
        val localUri = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI))
        cursor.close()
        val file = File(Uri.parse(localUri).path ?: return null)
        if (!file.exists()) return null
        return FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    }

    fun cancelDownload(downloadId: Long) {
        val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        dm.remove(downloadId)
    }

    private fun apkFile(versionName: String): File {
        val dir = File(context.cacheDir, "updates")
        dir.mkdirs()
        return File(dir, "vitalix-$versionName.apk")
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT)
            )
        }
    }

    companion object {
        private const val TAG = "UpdateManager"
        const val CHANNEL = "vitalix_updates"
        const val EXTRA_UPDATE_INFO = "update_info"

        fun parseUpdateInfo(json: JSONObject, currentVersionCode: Int): UpdateInfo? {
            val release = if (json.optString("install_url").isNotBlank()) json
                else json.optJSONArray("releases")?.optJSONObject(0)
                    ?: return null

            val downloadUrl = release.optString("install_url")
            if (downloadUrl.isBlank()) return null

            val buildVersion = release.optString("build_version")
            val remoteCode = buildVersion.toIntOrNull() ?: 0
            if (remoteCode <= currentVersionCode) return null

            val versionName = release.optString("version").ifBlank { buildVersion }
            val changelog = release.optString("changelog", "")

            return UpdateInfo(
                versionName = versionName,
                versionCode = remoteCode,
                changelog = changelog,
                downloadUrl = downloadUrl,
            )
        }
    }
}
```

- [ ] **Step 4: Enable parcelize plugin in build.gradle.kts**

In `android/build.gradle.kts`, add the parcelize plugin. Check if there's a `plugins` block at the root level — if not, this goes in `android/app/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.google.services)
    id("kotlin-parcelize")
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd android && ./gradlew testProductionDebugUnitTest --tests "com.android.vitalix.UpdateManagerTest" 2>&1 | tail -20
```

Expected: All 5 tests PASS.

- [ ] **Step 6: Update file_provider_paths.xml to include cache directory**

Replace `android/app/src/main/res/xml/file_provider_paths.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<paths>
    <external-path name="downloads" path="Download/" />
    <cache-path name="updates" path="updates/" />
</paths>
```

- [ ] **Step 7: Commit**

```bash
cd android
git add app/src/main/java/com/android/vitalix/UpdateManager.kt \
       app/src/test/java/com/android/vitalix/UpdateManagerTest.kt \
       app/src/main/res/xml/file_provider_paths.xml \
       app/build.gradle.kts
git commit -m "feat: add UpdateInfo data class and progress-tracking download API

Refactor UpdateManager to return UpdateInfo (version, changelog, download URL)
from checkForUpdate. Replace downloadAndInstall with two-step downloadApk +
getApkUri flow. Download APKs to cache dir via FileProvider instead of public
Downloads.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: UpdateActivity layout

**Files:**
- Create: `android/app/src/main/res/layout/activity_update.xml`
- Modify: `android/app/src/main/res/values/strings.xml` — add update strings
- Modify: `android/app/src/main/AndroidManifest.xml` — register UpdateActivity

**Interfaces:**
- Consumes: Nothing (layout-only task)
- Produces: Layout resource `R.layout.activity_update` with view IDs: `iconUpdate`, `txtHeading`, `txtVersion`, `scrollChangelog`, `txtChangelog`, `txtError`, `progressDownload`, `txtProgress`, `btnPrimary`, `btnNotNow`

- [ ] **Step 1: Add strings to strings.xml**

Add these entries before the closing `</resources>` tag in `android/app/src/main/res/values/strings.xml`:

```xml
    <string name="update_heading">New version available!</string>
    <string name="update_download">Download</string>
    <string name="update_install">Install</string>
    <string name="update_cancel">Cancel</string>
    <string name="update_retry">Retry</string>
    <string name="update_not_now">Not now</string>
    <string name="update_downloading">Downloading…</string>
```

- [ ] **Step 2: Create activity_update.xml layout**

Create `android/app/src/main/res/layout/activity_update.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:app="http://schemas.android.com/apk/res-auto"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:fitsSystemWindows="true">

    <ScrollView
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:fillViewport="true">

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:orientation="vertical"
            android:padding="24dp">

            <ImageView
                android:id="@+id/iconUpdate"
                android:layout_width="48dp"
                android:layout_height="48dp"
                android:layout_marginTop="48dp"
                android:layout_marginBottom="24dp"
                android:src="@android:drawable/ic_dialog_info"
                app:tint="?colorPrimary"
                android:contentDescription="Update icon" />

            <TextView
                android:id="@+id/txtHeading"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="@string/update_heading"
                android:textAppearance="?textAppearanceHeadlineMedium"
                android:textStyle="bold"
                android:layout_marginBottom="4dp" />

            <TextView
                android:id="@+id/txtVersion"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:textAppearance="?textAppearanceBodySmall"
                android:textColor="?android:textColorSecondary"
                android:layout_marginBottom="24dp" />

            <ScrollView
                android:id="@+id/scrollChangelog"
                android:layout_width="match_parent"
                android:layout_height="wrap_content">

                <TextView
                    android:id="@+id/txtChangelog"
                    android:layout_width="match_parent"
                    android:layout_height="wrap_content"
                    android:textAppearance="?textAppearanceBodyMedium"
                    android:lineSpacingExtra="4dp" />

            </ScrollView>

            <TextView
                android:id="@+id/txtError"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:layout_marginTop="16dp"
                android:textColor="@color/error_red"
                android:textAppearance="?textAppearanceBodySmall"
                android:visibility="gone" />

        </LinearLayout>
    </ScrollView>

    <LinearLayout
        android:id="@+id/barButtons"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="vertical"
        android:padding="16dp"
        android:paddingBottom="24dp"
        android:background="?colorSurface"
        android:elevation="8dp">

        <com.google.android.material.progressindicator.LinearProgressIndicator
            android:id="@+id/progressDownload"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginBottom="8dp"
            android:visibility="gone"
            app:indicatorColor="?colorPrimary"
            app:trackColor="?colorSurfaceVariant" />

        <TextView
            android:id="@+id/txtProgress"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginBottom="8dp"
            android:textAppearance="?textAppearanceBodySmall"
            android:gravity="center"
            android:visibility="gone" />

        <com.google.android.material.button.MaterialButton
            android:id="@+id/btnPrimary"
            android:layout_width="match_parent"
            android:layout_height="56dp"
            android:text="@string/update_download"
            android:textSize="16sp" />

        <com.google.android.material.button.MaterialButton
            android:id="@+id/btnNotNow"
            style="@style/Widget.Material3.Button.OutlinedButton"
            android:layout_width="match_parent"
            android:layout_height="56dp"
            android:layout_marginTop="8dp"
            android:text="@string/update_not_now"
            android:textSize="16sp" />

    </LinearLayout>

</LinearLayout>
```

- [ ] **Step 3: Register UpdateActivity in AndroidManifest.xml**

Add after the `OnboardingActivity` declaration (line 147 area) in `android/app/src/main/AndroidManifest.xml`:

```xml
        <activity
            android:name=".UpdateActivity"
            android:exported="false"
            android:theme="@style/Theme.Vitalix" />
```

- [ ] **Step 4: Build to verify layout compiles**

```bash
cd android && ./gradlew assembleProductionDebug 2>&1 | tail -10
```

Expected: BUILD SUCCESSFUL (UpdateActivity class doesn't exist yet, but the layout and manifest reference by name — the build should still pass since no code references the layout yet).

- [ ] **Step 5: Commit**

```bash
cd android
git add app/src/main/res/layout/activity_update.xml \
       app/src/main/res/values/strings.xml \
       app/src/main/AndroidManifest.xml
git commit -m "feat: add UpdateActivity layout and manifest entry

Full-screen Mihon-style update screen layout with changelog area,
progress indicator, and Download/Not now buttons.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: UpdateActivity implementation

**Files:**
- Create: `android/app/src/main/java/com/android/vitalix/UpdateActivity.kt`

**Interfaces:**
- Consumes:
  - `UpdateInfo` (Parcelable) via Intent extras keyed by `UpdateManager.EXTRA_UPDATE_INFO`
  - `UpdateManager.downloadApk(downloadUrl: String, versionName: String): Long`
  - `UpdateManager.queryProgress(downloadId: Long): DownloadProgress`
  - `UpdateManager.getApkUri(downloadId: Long): Uri?`
  - `UpdateManager.cancelDownload(downloadId: Long)`
  - Layout IDs from `activity_update.xml`: `iconUpdate`, `txtHeading`, `txtVersion`, `scrollChangelog`, `txtChangelog`, `txtError`, `progressDownload`, `txtProgress`, `btnPrimary`, `btnNotNow`, `barButtons`
- Produces:
  - `UpdateActivity.intent(context: Context, info: UpdateInfo): Intent` — companion factory method for launching

- [ ] **Step 1: Create UpdateActivity.kt**

Create `android/app/src/main/java/com/android/vitalix/UpdateActivity.kt`:

```kotlin
package com.android.vitalix

import android.app.DownloadManager
import android.content.Intent
import android.content.Context
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.BulletSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import com.android.vitalix.databinding.ActivityUpdateBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class UpdateActivity : AppCompatActivity() {

    private lateinit var binding: ActivityUpdateBinding
    private lateinit var updateManager: UpdateManager
    private lateinit var updateInfo: UpdateInfo

    private var downloadId: Long = -1
    private var progressJob: Job? = null

    private enum class State { READY, DOWNLOADING, DOWNLOADED, ERROR }
    private var state = State.READY

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityUpdateBinding.inflate(layoutInflater)
        setContentView(binding.root)

        updateInfo = intent.getParcelableExtra(UpdateManager.EXTRA_UPDATE_INFO, UpdateInfo::class.java)
            ?: run { finish(); return }

        updateManager = UpdateManager(this)

        downloadId = savedInstanceState?.getLong(KEY_DOWNLOAD_ID, -1) ?: -1

        binding.txtVersion.text = "v${updateInfo.versionName}"
        renderChangelog(updateInfo.changelog)
        applyNavBarInset()

        binding.btnPrimary.setOnClickListener { onPrimaryClicked() }
        binding.btnNotNow.setOnClickListener { onNotNowClicked() }

        if (downloadId != -1L) {
            resumeProgressTracking()
        } else {
            setState(State.READY)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putLong(KEY_DOWNLOAD_ID, downloadId)
    }

    override fun onDestroy() {
        progressJob?.cancel()
        super.onDestroy()
    }

    private fun onPrimaryClicked() {
        when (state) {
            State.READY -> startDownload()
            State.DOWNLOADING -> cancelDownload()
            State.DOWNLOADED -> installApk()
            State.ERROR -> startDownload()
        }
    }

    private fun onNotNowClicked() {
        if (state == State.DOWNLOADING) {
            updateManager.cancelDownload(downloadId)
        }
        finish()
    }

    override fun onBackPressed() {
        onNotNowClicked()
    }

    private fun startDownload() {
        setState(State.DOWNLOADING)
        downloadId = updateManager.downloadApk(updateInfo.downloadUrl, updateInfo.versionName)
        startProgressTracking()
    }

    private fun cancelDownload() {
        progressJob?.cancel()
        updateManager.cancelDownload(downloadId)
        downloadId = -1
        setState(State.READY)
    }

    private fun installApk() {
        val uri = updateManager.getApkUri(downloadId)
        if (uri == null) {
            showError("Downloaded file not found. Try again.")
            setState(State.ERROR)
            return
        }
        val install = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivity(install)
    }

    private fun resumeProgressTracking() {
        val progress = updateManager.queryProgress(downloadId)
        when (progress.status) {
            DownloadManager.STATUS_SUCCESSFUL -> setState(State.DOWNLOADED)
            DownloadManager.STATUS_FAILED -> {
                showError("Download failed. Tap Retry.")
                setState(State.ERROR)
            }
            else -> {
                setState(State.DOWNLOADING)
                startProgressTracking()
            }
        }
    }

    private fun startProgressTracking() {
        progressJob?.cancel()
        progressJob = lifecycleScope.launch {
            while (isActive) {
                val progress = withContext(Dispatchers.IO) {
                    updateManager.queryProgress(downloadId)
                }
                when (progress.status) {
                    DownloadManager.STATUS_SUCCESSFUL -> {
                        binding.progressDownload.progress = 100
                        binding.txtProgress.text = "100%"
                        setState(State.DOWNLOADED)
                        return@launch
                    }
                    DownloadManager.STATUS_FAILED -> {
                        showError("Download failed. Tap Retry.")
                        setState(State.ERROR)
                        return@launch
                    }
                    else -> {
                        if (progress.bytesTotal > 0) {
                            val pct = (progress.bytesDownloaded * 100 / progress.bytesTotal).toInt()
                            binding.progressDownload.progress = pct
                            binding.txtProgress.text = "$pct%"
                        }
                    }
                }
                delay(300)
            }
        }
    }

    private fun setState(newState: State) {
        state = newState
        when (newState) {
            State.READY -> {
                binding.btnPrimary.text = getString(R.string.update_download)
                binding.progressDownload.visibility = View.GONE
                binding.txtProgress.visibility = View.GONE
                binding.txtError.visibility = View.GONE
            }
            State.DOWNLOADING -> {
                binding.btnPrimary.text = getString(R.string.update_cancel)
                binding.progressDownload.visibility = View.VISIBLE
                binding.progressDownload.progress = 0
                binding.txtProgress.visibility = View.VISIBLE
                binding.txtProgress.text = "0%"
                binding.txtError.visibility = View.GONE
            }
            State.DOWNLOADED -> {
                binding.btnPrimary.text = getString(R.string.update_install)
                binding.progressDownload.visibility = View.GONE
                binding.txtProgress.visibility = View.GONE
                binding.txtError.visibility = View.GONE
            }
            State.ERROR -> {
                binding.btnPrimary.text = getString(R.string.update_retry)
                binding.progressDownload.visibility = View.GONE
                binding.txtProgress.visibility = View.GONE
            }
        }
    }

    private fun showError(message: String) {
        binding.txtError.text = message
        binding.txtError.visibility = View.VISIBLE
    }

    private fun renderChangelog(raw: String) {
        if (raw.isBlank()) {
            binding.scrollChangelog.visibility = View.GONE
            return
        }
        val ssb = SpannableStringBuilder()
        for (line in raw.lines()) {
            when {
                line.startsWith("### ") || line.startsWith("## ") -> {
                    val text = line.removePrefix("### ").removePrefix("## ")
                    val start = ssb.length
                    ssb.append(text).append("\n")
                    ssb.setSpan(StyleSpan(Typeface.BOLD), start, start + text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    ssb.setSpan(RelativeSizeSpan(1.1f), start, start + text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                line.startsWith("- ") || line.startsWith("* ") -> {
                    val text = line.removePrefix("- ").removePrefix("* ")
                    val start = ssb.length
                    ssb.append(text).append("\n")
                    ssb.setSpan(BulletSpan(16), start, ssb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                line.isBlank() -> ssb.append("\n")
                else -> ssb.append(line).append("\n")
            }
        }
        binding.txtChangelog.text = ssb
    }

    private fun applyNavBarInset() {
        val bar = binding.barButtons
        val basePadding = bar.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(bar) { view, insets ->
            val bottom = insets.getInsets(
                WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.systemGestures()
            ).bottom
            view.updatePadding(bottom = basePadding + bottom)
            insets
        }
        ViewCompat.requestApplyInsets(bar)
    }

    companion object {
        private const val KEY_DOWNLOAD_ID = "download_id"

        fun intent(context: Context, info: UpdateInfo): Intent =
            Intent(context, UpdateActivity::class.java)
                .putExtra(UpdateManager.EXTRA_UPDATE_INFO, info)
    }
}
```

- [ ] **Step 2: Build to verify compilation**

```bash
cd android && ./gradlew assembleProductionDebug 2>&1 | tail -15
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Commit**

```bash
cd android
git add app/src/main/java/com/android/vitalix/UpdateActivity.kt
git commit -m "feat: add UpdateActivity with Mihon-style update screen

Full-screen update screen with changelog rendering, download progress bar,
and install button. States: READY → DOWNLOADING → DOWNLOADED / ERROR.
Survives rotation by saving downloadId in instance state.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Wire MainActivity and VitalixFirebaseService to UpdateActivity

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/MainActivity.kt:195-223`
- Modify: `android/app/src/main/java/com/android/vitalix/VitalixFirebaseService.kt:24-49`

**Interfaces:**
- Consumes:
  - `UpdateActivity.intent(context: Context, info: UpdateInfo): Intent`
  - `UpdateManager.checkForUpdate(endpoint, channelKey, currentVersionCode, onUpdateAvailable: (UpdateInfo) -> Unit)`
  - `UpdateManager.EXTRA_UPDATE_INFO`
- Produces: Nothing new — wires existing components together

- [ ] **Step 1: Update MainActivity.checkForAppUpdate and handleUpdateIntent**

In `android/app/src/main/java/com/android/vitalix/MainActivity.kt`, replace `handleUpdateIntent` (lines 195-199) with:

```kotlin
    private fun handleUpdateIntent(intent: Intent?) {
        val info: UpdateInfo = intent?.getParcelableExtra(UpdateManager.EXTRA_UPDATE_INFO, UpdateInfo::class.java)
            ?: return
        intent.removeExtra(UpdateManager.EXTRA_UPDATE_INFO)
        startActivity(UpdateActivity.intent(this, info))
    }
```

Replace `checkForAppUpdate` (lines 204-223) with:

```kotlin
    private fun checkForAppUpdate() {
        if (BuildConfig.ZEALOT_ENDPOINT.isBlank() || BuildConfig.ZEALOT_CHANNEL_KEY.isBlank()) return
        UpdateManager(this).checkForUpdate(
            endpoint = BuildConfig.ZEALOT_ENDPOINT,
            channelKey = BuildConfig.ZEALOT_CHANNEL_KEY,
            currentVersionCode = BuildConfig.VERSION_CODE
        ) { info ->
            runOnUiThread {
                startActivity(UpdateActivity.intent(this, info))
            }
        }
    }
```

Remove these now-unused imports from MainActivity.kt (if present):
- `import androidx.appcompat.app.AlertDialog` (check usage — if nothing else uses it, remove)

- [ ] **Step 2: Update VitalixFirebaseService**

In `android/app/src/main/java/com/android/vitalix/VitalixFirebaseService.kt`, replace `onMessageReceived` (lines 20-29) with:

```kotlin
    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        Log.d(TAG, "FCM message received: type=${data["type"]}")

        if (data["type"] == "app_update") {
            val version = data["version"] ?: "new version"
            val downloadUrl = data["download_url"] ?: return
            val changelog = data["changelog"] ?: ""
            val versionCode = data["version_code"]?.toIntOrNull() ?: 0
            showUpdateNotification(
                UpdateInfo(
                    versionName = version,
                    versionCode = versionCode,
                    changelog = changelog,
                    downloadUrl = downloadUrl,
                )
            )
        }
    }
```

Replace `showUpdateNotification` (lines 31-51) with:

```kotlin
    private fun showUpdateNotification(info: UpdateInfo) {
        ensureChannel()
        val intent = UpdateActivity.intent(this, info).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, UpdateManager.CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("Vitalix Update Available")
            .setContentText("Version ${info.versionName} is ready to install")
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID, notification)
    }
```

- [ ] **Step 3: Build to verify compilation**

```bash
cd android && ./gradlew assembleProductionDebug 2>&1 | tail -15
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Run all existing tests to check for regressions**

```bash
cd android && ./gradlew testProductionDebugUnitTest 2>&1 | tail -20
```

Expected: All tests pass (including new UpdateManagerTest from Task 1).

- [ ] **Step 5: Commit**

```bash
cd android
git add app/src/main/java/com/android/vitalix/MainActivity.kt \
       app/src/main/java/com/android/vitalix/VitalixFirebaseService.kt
git commit -m "feat: wire MainActivity and FCM to UpdateActivity

Replace AlertDialog update prompt with full-screen UpdateActivity launch.
FCM app_update notifications now include changelog and route taps
through UpdateActivity instead of direct download.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Clean up dead code and remove old UpdateManager extras

**Files:**
- Modify: `android/app/src/main/java/com/android/vitalix/UpdateManager.kt` — remove old constants if still present
- Modify: `android/app/src/main/java/com/android/vitalix/MainActivity.kt` — remove unused imports

**Interfaces:**
- Consumes: Nothing
- Produces: Nothing new — cleanup only

- [ ] **Step 1: Verify no remaining references to old constants**

```bash
cd android && grep -rn "EXTRA_DOWNLOAD_URL\|EXTRA_VERSION\|downloadAndInstall" app/src/main/java/ 2>/dev/null
```

Expected: No matches. If any remain, remove them.

- [ ] **Step 2: Check for unused imports in modified files**

```bash
cd android && grep -n "^import.*AlertDialog" app/src/main/java/com/android/vitalix/MainActivity.kt
```

Remove any unused imports found.

- [ ] **Step 3: Build and test**

```bash
cd android && ./gradlew assembleProductionDebug testProductionDebugUnitTest 2>&1 | tail -15
```

Expected: BUILD SUCCESSFUL, all tests pass.

- [ ] **Step 4: Commit (only if changes were made)**

```bash
cd android
git add -u
git diff --cached --quiet || git commit -m "chore: remove dead update code and unused imports

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
