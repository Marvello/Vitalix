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
        // Token registration with server (fcm_tokens table) is a future task.
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
