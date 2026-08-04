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


        val cfg = settings.readConfig().copy(daysBack = daysSinceLastSync(settings))
        val log = SyncLog(applicationContext)
        val (from, to) = SyncLog.trailingWindow(cfg.daysBack)
        val runId = log.start(SyncLog.Kind.AUTO, from, to)

        return try {
            val manager = HealthConnectManager(applicationContext)
            val days = manager.readHealthDataByDay(cfg)
            val meta = PayloadMeta(
                appVersion = appVersion(),
                device = Build.MODEL,
                rangeDays = cfg.daysBack,
                profileHeightM = settings.userHeightCm?.let { it / 100.0 },
                bmiScale = settings.resolvedBmiScale(),
            )
            ServerForwarder.forwardChunked(applicationContext, url, days, meta).fold(
                onSuccess = {
                    settings.lastSync = System.currentTimeMillis()
                    val missed = manager.lastFailedMetrics
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

    private fun daysSinceLastSync(s: SyncSettings): Int {
        if (s.lastSync == 0L) return 1
        val days = ChronoUnit.DAYS.between(Instant.ofEpochMilli(s.lastSync), Instant.now())
        return days.toInt().coerceAtLeast(1)
    }

    companion object {
        const val NAME = "vitalix_auto_export"

        fun schedule(context: Context, hours: Int) {
            val req = PeriodicWorkRequestBuilder<ExportWorker>(hours.toLong(), TimeUnit.HOURS)
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
