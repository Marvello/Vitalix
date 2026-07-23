package com.android.vitalix

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.Date
import java.util.Locale

/**
 * One-time full-history backfill, run as foreground work so it survives the
 * screen sleeping, the app being backgrounded, and the Activity being destroyed —
 * a decade of Health Connect data takes far longer than a screen timeout.
 *
 * Walks backwards from today one slice at a time, forwarding each slice on its own
 * so no single request carries years of samples, and reports progress through
 * [WorkInfo.getProgress] for the UI plus an ongoing notification.
 */
class BackfillWorker(
    private val ctx: Context,
    params: WorkerParameters,
) : CoroutineWorker(ctx, params) {

    private val dayLabel = SimpleDateFormat("MMM d, yyyy", Locale.getDefault())

    override suspend fun getForegroundInfo(): ForegroundInfo = foregroundInfo("Starting…")

    override suspend fun doWork(): Result {
        val settings = SyncSettings(ctx)
        val url = settings.serverUrl?.trim().orEmpty()
        if (url.isBlank()) return Result.failure(message("No server URL configured"))

        setForeground(foregroundInfo("Starting…"))

        val cfg = settings.readConfig()
        val manager = HealthConnectManager(ctx)
        // One read per metric per slice: the slice already bounds the window, so
        // pacing belongs between slices, not inside them.
        manager.setSaferExportMode(cfg.saferExportMode, chunkDays = WINDOW_DAYS, delayMs = 0L)

        var end = Instant.now()
        val floor = end.minus(MAX_DAYS, ChronoUnit.DAYS)
        var emptyRun = 0
        var slices = 0
        var daysSent = 0

        try {
            while (end.isAfter(floor) && emptyRun < EMPTY_LIMIT) {
                if (isStopped) return Result.failure(message("Cancelled after $daysSent days"))

                val start = maxOf(end.minus(WINDOW_DAYS, ChronoUnit.DAYS), floor)
                slices++
                report("Reading ${dayLabel.format(Date(start.toEpochMilli()))}", daysSent)

                val days = manager.readHealthDataByDay(cfg, start, end)
                if (days.isEmpty()) {
                    emptyRun++
                } else {
                    emptyRun = 0
                    val json = ServerForwarder.buildPayload(
                        days,
                        PayloadMeta(appVersion(), Build.MODEL, WINDOW_DAYS.toInt())
                    )
                    val result = ServerForwarder.forward(ctx, url, json)
                    if (result.isFailure) {
                        val err = result.exceptionOrNull()
                        val detail = when {
                            err is ServerForwarder.HttpException && err.code == 401 ->
                                "session expired — sign in again"
                            err is ServerForwarder.HttpException -> "HTTP ${err.code}"
                            else -> err?.message ?: "unknown error"
                        }
                        // Everything already sent stays on the server; re-running
                        // resumes rather than restarting.
                        return Result.failure(message("Stopped after $daysSent days: $detail"))
                    }
                    daysSent += days.size
                }
                end = start
                if (cfg.saferExportMode) delay(SLICE_PAUSE_MS)
            }

            settings.lastSync = System.currentTimeMillis()
            return Result.success(
                workDataOf(KEY_MESSAGE to "Full history sent ($daysSent days over $slices slices)",
                    KEY_DAYS to daysSent)
            )
        } catch (e: Exception) {
            return Result.failure(message("Failed after $daysSent days: ${e.message}"))
        }
    }

    private suspend fun report(status: String, daysSent: Int) {
        setProgress(workDataOf(KEY_MESSAGE to status, KEY_DAYS to daysSent))
        setForeground(foregroundInfo("$status ($daysSent days sent)"))
    }

    private fun message(text: String) = workDataOf(KEY_MESSAGE to text)

    private fun foregroundInfo(text: String): ForegroundInfo {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Vitalix sync", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val notification = NotificationCompat.Builder(ctx, CHANNEL)
            .setContentTitle("Vitalix full history")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .setSilent(true)
            .build()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(NOTIFICATION_ID, notification)
        }
    }

    private fun appVersion(): String = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "1.0.0"
    } catch (_: Exception) {
        "1.0.0"
    }

    companion object {
        const val NAME = "vitalix_backfill"
        const val KEY_MESSAGE = "message"
        const val KEY_DAYS = "days"

        private const val CHANNEL = "vitalix_sync"
        private const val NOTIFICATION_ID = 4201

        /** Slice size: one upload per window. */
        private const val WINDOW_DAYS = 30L
        /** Stop after this many consecutive empty slices — Health Connect has run dry. */
        private const val EMPTY_LIMIT = 6
        /** Hard floor, so odd timestamps can't loop forever. */
        private const val MAX_DAYS = 3650L
        /** Breather between slices when safer-export mode is on. */
        private const val SLICE_PAUSE_MS = 1000L

        fun start(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork(
                NAME,
                // Don't restart a backfill that's already walking backwards.
                ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<BackfillWorker>().build()
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(NAME)
        }

        fun statusOf(data: Data?): String? = data?.getString(KEY_MESSAGE)
    }
}
