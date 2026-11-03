package com.android.vitalix

import android.content.Context
import android.os.Build
import com.android.vitalix.health.ChangesPlanner
import com.android.vitalix.models.DailyHealthData
import com.android.vitalix.widget.WidgetState
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
 * Periodic background export. With a valid Health Connect changes token it re-reads
 * only the days that changed (plus yesterday and today) and sends deletions;
 * otherwise it reads the window since the last sync and takes a fresh token.
 * Scheduled/cancelled via [schedule]/[cancel] from the auto-sync toggle in [MainActivity].
 */
class ExportWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val settings = SyncSettings(applicationContext)
        val url = settings.serverUrl
        if (url.isNullOrBlank()) return Result.failure()

        val zone = ZoneId.systemDefault()
        val today = LocalDate.now(zone)
        val windowCfg = settings.readConfig().copy(daysBack = daysToRead(settings.lastSync, today))
        val log = SyncLog(applicationContext)
        val (from, to) = SyncLog.trailingWindow(windowCfg.daysBack)
        val runId = log.start(SyncLog.Kind.AUTO, from, to)

        return try {
            val manager = HealthConnectManager(applicationContext)
            if (!manager.canReadInBackground()) {
                log.finish(runId, SyncLog.Status.FAILED,
                    message = "Background access not granted — open Vitalix and tap Sync to allow it")
                return Result.failure()
            }
            // The token covers the granted types only; a grant change voids it.
            val granted = manager.grantedRecordTypes()
            val typesKey = SyncSettings.typesKey(granted.map { it.simpleName.orEmpty() })
            val plan = ChangesPlanner.planFrom(manager.changes, settings.changesToken(typesKey), zone, today)
            val days: List<DailyHealthData>
            val nextToken: String?
            if (plan.fallback) {
                // Token taken before the read, so changes made during it are not lost.
                nextToken = manager.newChangesToken(granted)
                days = manager.readHealthDataByDay(windowCfg)
            } else {
                nextToken = plan.nextToken
                days = manager.readDays(windowCfg, plan.days)
            }
            val deletedIds = plan.deletedIds
            val meta = PayloadMeta(
                appVersion = appVersion(),
                device = Build.MODEL,
                rangeDays = if (plan.fallback) windowCfg.daysBack else plan.days.size,
                profileHeightM = settings.userHeightCm?.let { it / 100.0 },
                bmiScale = settings.resolvedBmiScale(),
                failedMetrics = manager.lastFailedMetrics,
            )
            ServerForwarder.forwardChunked(applicationContext, url, days, meta, deletedHcIds = deletedIds).fold(
                onSuccess = { deleted ->
                    val missed = manager.lastFailedMetrics
                    // Only a clean, non-empty send moves lastSync and the token forward:
                    // a throttled metric or an empty read gets re-read next run.
                    if (missed.isEmpty() && (days.isNotEmpty() || deletedIds.isNotEmpty())) {
                        settings.lastSync = System.currentTimeMillis()
                        if (nextToken != null) settings.saveChangesToken(nextToken, typesKey)
                    }
                    WidgetState.noteDays(applicationContext, days)
                    log.finish(
                        runId,
                        if (missed.isEmpty()) SyncLog.Status.SENT else SyncLog.Status.PARTIAL,
                        days = days.size,
                        message = listOfNotNull(
                            "full window".takeIf { plan.fallback },
                            applicationContext.getString(R.string.sync_older_skipped).takeIf { plan.truncated },
                            "$deleted deleted".takeIf { deleted > 0 },
                            "could not read ${missed.joinToString(", ")}".takeIf { missed.isNotEmpty() },
                        ).joinToString("; ").ifEmpty { null }?.replaceFirstChar { it.uppercase() },
                        from = plan.days.firstOrNull()?.toString(),
                        to = plan.days.lastOrNull()?.toString(),
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
