package com.android.vitalix

import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Parcel
import android.os.Parcelable
import android.util.Log
import androidx.core.content.FileProvider
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException

// Hand-written Parcelable: this build has no Kotlin Gradle plugin on the
// classpath (AGP 9's built-in Kotlin support only), so the `kotlin-parcelize`
// compiler plugin isn't available to generate this boilerplate.
data class UpdateInfo(
    val versionName: String,
    val versionCode: Int,
    val changelog: String,
    val downloadUrl: String,
) : Parcelable {

    constructor(parcel: Parcel) : this(
        versionName = parcel.readString().orEmpty(),
        versionCode = parcel.readInt(),
        changelog = parcel.readString().orEmpty(),
        downloadUrl = parcel.readString().orEmpty(),
    )

    override fun writeToParcel(dest: Parcel, flags: Int) {
        dest.writeString(versionName)
        dest.writeInt(versionCode)
        dest.writeString(changelog)
        dest.writeString(downloadUrl)
    }

    override fun describeContents(): Int = 0

    companion object CREATOR : Parcelable.Creator<UpdateInfo> {
        override fun createFromParcel(parcel: Parcel): UpdateInfo = UpdateInfo(parcel)
        override fun newArray(size: Int): Array<UpdateInfo?> = arrayOfNulls(size)
    }
}

data class DownloadProgress(
    val bytesDownloaded: Long,
    val bytesTotal: Long,
    val status: Int,
)

/**
 * Handles the two Zealot-driven update flows:
 *  - manual check on app open (checkForUpdate), which hits the Zealot "latest
 *    release for channel" API directly rather than depending on the Zealot
 *    Android SDK (published only as a JitPack SNAPSHOT — too fragile for a
 *    reproducible build; see task-5 brief note).
 *  - APK download with progress tracking (downloadApk / queryProgress /
 *    getApkUri), triggered either from that manual check or from tapping an
 *    FCM push notification.
 */
class UpdateManager(private val context: Context) {

    private val httpClient = OkHttpClient()

    /**
     * Hits Zealot's public "latest release for channel" endpoint and invokes
     * [onUpdateAvailable] on a background thread if a newer version is found.
     * Network failures are logged and swallowed — an update check must never
     * crash or block the caller.
     */
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
