package com.android.vitalix

import android.content.Context
import android.os.Build
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.concurrent.TimeUnit

/**
 * Periodic background export: reads Health Connect data since the last sync and
 * forwards it to the configured server. Scheduled/cancelled via [schedule]/[cancel]
 * from the auto-sync toggle in [MainActivity].
 */
class ExportWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val settings = SyncSettings(applicationContext)
        val url = settings.serverUrl
        if (url.isNullOrBlank()) return Result.failure()


        val cfg = settings.readConfig().copy(
            daysBack = daysToRead(settings.lastSync, LocalDate.now(ZoneId.systemDefault()))
        )
        val log = SyncLog(applicationContext)
        val (from, to) = SyncLog.trailingWindow(cfg.daysBack)
        val runId = log.start(SyncLog.Kind.AUTO, from, to)

        return try {
            val manager = HealthConnectManager(applicationContext)
            if (!manager.canReadInBackground()) {
                log.finish(runId, SyncLog.Status.FAILED,
                    message = "Background access not granted — open Vitalix and tap Sync to allow it")
                return Result.failure()
            }
            val days = manager.readHealthDataByDay(cfg)
            val meta = PayloadMeta(
                appVersion = appVersion(),
                device = Build.MODEL,
                rangeDays = cfg.daysBack,
                profileHeightM = settings.userHeightCm?.let { it / 100.0 },
                bmiScale = settings.resolvedBmiScale(),
                failedMetrics = manager.lastFailedMetrics,
            )
            ServerForwarder.forwardChunked(applicationContext, url, days, meta).fold(
                onSuccess = {
                    val missed = manager.lastFailedMetrics
                    // Only a clean, non-empty read moves the window forward: a
                    // throttled metric or an empty read gets re-read next run.
                    if (missed.isEmpty() && days.isNotEmpty()) settings.lastSync = System.currentTimeMillis()
                    log.finish(
                        runId,
                        if (missed.isEmpty()) SyncLog.Status.SENT else SyncLog.Status.PARTIAL,
                        days = days.size,
                        message = if (missed.isEmpty()) null else "Could not read ${missed.joinToString(", ")}",
                    )
                    Result.success()
                },
                onFailure = { e ->
                    log.finish(runId, SyncLog.Status.FAILED, message = e.message)
                    when {
                        e is ServerForwarder.PayloadTooLargeException -> {
                            // Payload too large even after chunking — unrecoverable for this data range
                            Result.failure()
                        }
                        e is ServerForwarder.HttpException && e.code == 401 -> {
                            // AuthedHttp's authenticator already tried to refresh and failed
                            // (clearing AuthStore). Don't infinite-retry a dead session.
                            Result.failure()
                        }
                        e is ServerForwarder.HttpException && e.code in 400..499 -> Result.failure()
                        else -> Result.retry()
                    }
                }
            )
        } catch (e: ServerForwarder.PayloadTooLargeException) {
            log.finish(runId, SyncLog.Status.FAILED, message = e.message)
            Result.failure()
        } catch (e: Exception) {
            log.finish(runId, SyncLog.Status.FAILED, message = e.message)
            Result.retry()
        }
    }

    private fun appVersion(): String = try {
        applicationContext.packageManager
            .getPackageInfo(applicationContext.packageName, 0).versionName ?: "1.0.0"
    } catch (_: Exception) {
        "1.0.0"
    }

    companion object {
        /**
         * Calendar days to read, today included: back to the last sync's day, and
         * never less than yesterday + today — a wearable often hands over last
         * night's data hours after midnight.
         */
        fun daysToRead(lastSyncMs: Long, today: LocalDate, zone: ZoneId = ZoneId.systemDefault()): Int {
            if (lastSyncMs == 0L) return 2
            val lastDay = Instant.ofEpochMilli(lastSyncMs).atZone(zone).toLocalDate()
            return (ChronoUnit.DAYS.between(lastDay, today).toInt() + 1).coerceAtLeast(2)
        }

        const val NAME = "vitalix_auto_export"

        /** Fixed auto-sync cadence: every 4h = 6 runs/day. */
        const val INTERVAL_HOURS = 4

        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<ExportWorker>(INTERVAL_HOURS.toLong(), TimeUnit.HOURS)
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.UPDATE, req)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(NAME)
        }
    }
}
