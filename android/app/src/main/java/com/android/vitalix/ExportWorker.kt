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

        return try {
            val cfg = settings.readConfig().copy(daysBack = daysSinceLastSync(settings))
            val days = HealthConnectManager(applicationContext).readHealthDataByDay(cfg)
            val meta = PayloadMeta(appVersion(), Build.MODEL, cfg.daysBack)
            val json = ServerForwarder.buildPayload(days, meta)
            ServerForwarder.forward(url, settings.authToken, json).fold(
                onSuccess = {
                    settings.lastSync = System.currentTimeMillis()
                    Result.success()
                },
                onFailure = { e ->
                    if (e is ServerForwarder.HttpException && e.code in 400..499) {
                        Result.failure()
                    } else {
                        Result.retry()
                    }
                }
            )
        } catch (e: Exception) {
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
        private const val NAME = "vitalix_auto_export"

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
