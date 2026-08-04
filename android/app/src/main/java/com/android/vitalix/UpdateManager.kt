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
import androidx.core.content.ContextCompat
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.IOException

/**
 * Handles the two Zealot-driven update flows:
 *  - manual check on app open (checkForUpdate), which hits the Zealot "latest
 *    release for channel" API directly rather than depending on the Zealot
 *    Android SDK (published only as a JitPack SNAPSHOT — too fragile for a
 *    reproducible build; see task-5 brief note).
 *  - APK download + install prompt (downloadAndInstall), triggered either
 *    from that manual check or from tapping an FCM push notification.
 */
class UpdateManager(private val context: Context) {

    private var downloadId: Long = -1
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
        currentVersionName: String,
        onUpdateAvailable: (version: String, downloadUrl: String) -> Unit
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
                        val downloadUrl = json.optString("install_url").ifBlank {
                            json.optJSONArray("releases")
                                ?.optJSONObject(0)
                                ?.optString("install_url")
                                .orEmpty()
                        }
                        val version = json.optString("version").ifBlank {
                            json.optJSONArray("releases")
                                ?.optJSONObject(0)
                                ?.optString("version")
                                .orEmpty()
                        }
                        if (downloadUrl.isNotBlank() && version.isNotBlank() && version != currentVersionName) {
                            onUpdateAvailable(version, downloadUrl)
                        }
                    } catch (e: Exception) {
                        Log.w(TAG, "Update check parse failed: ${e.message}")
                    }
                }
            }
        })
    }

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
                context.applicationContext.unregisterReceiver(this)
                onDownloadComplete(dm, id)
            }
        }
        ContextCompat.registerReceiver(
            context.applicationContext, receiver,
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
                NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT)
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
