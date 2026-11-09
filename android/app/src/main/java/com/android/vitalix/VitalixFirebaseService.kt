package com.android.vitalix

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import com.android.vitalix.widget.WidgetState
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class VitalixFirebaseService : FirebaseMessagingService() {

    // FID-based registration: FCM delivers the token here after FcmRegistrar.register().
    override fun onRegistered(token: String) {
        FcmRegistrar.upload(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        Log.d(TAG, "FCM message received: type=${data["type"]}")

        if (data["type"] == "no_sync") {
            showNoSyncNotification()
            return
        }

        if (data["type"] == "insight_ready") {
            WidgetState.noteInsightReady(this, data["day"])
            showInsightNotification(data["day"])
            return
        }

        if (data["type"] == "digest_ready") {
            showDigestNotification(data["kind"])
            return
        }

        if (data["type"] == "anomaly") {
            showAnomalyNotification(data["day"], data["rule"], data["value"], data["baseline"])
            return
        }

        if (data["type"] == "app_update") {
            val version = data["version"] ?: "new version"
            val downloadUrl = data["download_url"] ?: return
            val versionCode = data["version_code"]?.toIntOrNull() ?: 0
            // Same rule as UpdateManager.parseUpdateInfo: never offer a downgrade.
            if (versionCode <= BuildConfig.VERSION_CODE) return
            val changelog = data["changelog"] ?: ""
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

    private fun ensureChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(UpdateManager.CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT)
        )
    }

    private fun showNoSyncNotification() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(SYNC_CHANNEL, "Sync alerts", NotificationManager.IMPORTANCE_DEFAULT)
        )
        val intent = Intent(this, MainActivity::class.java)
            .apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP }
        val pending = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, SYNC_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle("Vitalix — sync stalled")
            .setContentText("No health data sent recently. Open to check Health Connect and connection.")
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        getSystemService(NotificationManager::class.java).notify(NO_SYNC_NOTIFICATION_ID, notification)
    }

    private fun showInsightNotification(day: String?) {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(INSIGHTS_CHANNEL, "Health insights", NotificationManager.IMPORTANCE_DEFAULT)
        )
        val pending = PendingIntent.getActivity(
            this, INSIGHT_NOTIFICATION_ID,
            InsightActivity.intent(this, day).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, INSIGHTS_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_info_details)
            .setContentTitle("Your health insight is ready")
            .setContentText("Tap to see today's personalized recommendations.")
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        getSystemService(NotificationManager::class.java).notify(INSIGHT_NOTIFICATION_ID, notification)
    }

    private fun showDigestNotification(kind: String?) {
        val title = digestTitle(kind) ?: return // unknown kind: stay silent
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(INSIGHTS_CHANNEL, "Health insights", NotificationManager.IMPORTANCE_DEFAULT)
        )
        val id = digestNotificationId(kind)
        val pending = PendingIntent.getActivity(
            this, id,
            InsightActivity.intent(this, digestKind = kind).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, INSIGHTS_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_info_details)
            .setContentTitle(title)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        // Own id per kind so a weekly and a monthly summary don't replace each other or the daily insight.
        getSystemService(NotificationManager::class.java).notify(id, notification)
    }

    private fun showAnomalyNotification(day: String?, rule: String?, value: String?, baseline: String?) {
        val body = anomalyText(rule, value, baseline) ?: return // unknown rule: stay silent
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(ALERTS_CHANNEL, "Alerts", NotificationManager.IMPORTANCE_DEFAULT)
        )
        val id = anomalyNotificationId(rule) ?: return
        val pending = PendingIntent.getActivity(
            this, id,
            InsightActivity.intent(this, day).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, ALERTS_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle(getString(R.string.alert_title))
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        // One notification per rule so same-day alerts don't replace each other.
        getSystemService(NotificationManager::class.java).notify(id, notification)
    }

    private fun anomalyText(rule: String?, value: String?, baseline: String?): String? {
        val (res, args) = anomalyCopy(rule, value.orEmpty(), baseline.orEmpty()) ?: return null
        return getString(res, *args.toTypedArray())
    }

    companion object {
        // Notification id doubles as the PendingIntent request code: intents differing
        // only in extras collapse otherwise, and a tap opens whatever was pushed last.
        /** Own id per kind so a weekly and a monthly summary don't replace each other or the daily insight. */
        fun digestNotificationId(kind: String?) = DIGEST_NOTIFICATION_BASE + if (kind == "month") 1 else 0

        /** One fixed id per known rule so same-day alerts don't replace each other; null for an unknown rule. */
        fun anomalyNotificationId(rule: String?): Int? = when (rule) {
            "rhr_up" -> ANOMALY_NOTIFICATION_BASE
            "hrv_drop" -> ANOMALY_NOTIFICATION_BASE + 1
            "spo2_low" -> ANOMALY_NOTIFICATION_BASE + 2
            "bp_high" -> ANOMALY_NOTIFICATION_BASE + 3
            else -> null
        }

        /** Push `kind` -> notification title; null for an unknown kind. */
        fun digestTitle(kind: String?): String? = when (kind) {
            "week" -> "Your weekly summary is ready"
            "month" -> "Your monthly summary is ready"
            else -> null
        }

        /** Rule + push values -> (string resource, format args); null for an unknown rule. */
        fun anomalyCopy(rule: String?, value: String, baseline: String): Pair<Int, List<String>>? = when (rule) {
            "rhr_up" -> R.string.alert_rhr_up to listOf(value, baseline)
            "hrv_drop" -> R.string.alert_hrv_drop to listOf(value, baseline)
            "spo2_low" -> R.string.alert_spo2_low to listOf(value)
            "bp_high" -> R.string.alert_bp_high to listOf(value)
            else -> null
        }

        private const val ANOMALY_NOTIFICATION_BASE = 4400
        private const val DIGEST_NOTIFICATION_BASE = 4310
        private const val ALERTS_CHANNEL = "alerts"
        private const val TAG = "VitalixFCM"
        private const val NOTIFICATION_ID = 4300
        private const val NO_SYNC_NOTIFICATION_ID = 4301
        private const val INSIGHT_NOTIFICATION_ID = 4302
        private const val SYNC_CHANNEL = "sync_alerts"
        private const val INSIGHTS_CHANNEL = "insights"
    }
}
