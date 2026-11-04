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
import java.time.LocalDate
import java.time.ZoneId
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
        val log = SyncLog(applicationContext)
        // Logged range before planning: the window since lastSync (capped); the token
        // path overwrites it with the days it actually read.
        val (from, to) = SyncLog.trailingWindow(
            SyncDecision.daysToRead(settings.lastSync, today, zone).coerceAtMost(SyncDecision.MAX_FALLBACK_DAYS))
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
            val decision = SyncDecision.decide(plan, settings.lastSync, today, zone)
            val windowCfg = settings.readConfig().copy(daysBack = decision.daysBack)
            val fallback = decision.mode == SyncDecision.Mode.FALLBACK
            // Fallback: token taken before the read, so changes made during it are not lost.
            val nextToken = if (decision.takeFreshToken) manager.newChangesToken(granted) else decision.nextToken
            val days: List<DailyHealthData> =
                if (fallback) manager.readHealthDataByDay(windowCfg) else manager.readDays(windowCfg, decision.days)
            val deletedIds = decision.deletedIds
            val meta = PayloadMeta(
                appVersion = appVersion(),
                device = Build.MODEL,
                rangeDays = if (fallback) decision.daysBack else decision.days.size,
                profileHeightM = settings.userHeightCm?.let { it / 100.0 },
                bmiScale = settings.resolvedBmiScale(),
                failedMetrics = manager.lastFailedMetrics,
            )
            // Nothing read and nothing deleted: forwardChunked sends no request.
            ServerForwarder.forwardChunked(applicationContext, url, days, meta, deletedHcIds = deletedIds).fold(
                onSuccess = { deleted ->
                    val missed = manager.lastFailedMetrics
                    val commit = decision.commit(readAnyDays = days.isNotEmpty(), clean = missed.isEmpty())
                    if (commit.saveLastSync) settings.lastSync = System.currentTimeMillis()
                    if (commit.saveToken && nextToken != null) settings.saveChangesToken(nextToken, typesKey)
                    WidgetState.noteDays(applicationContext, days)
                    log.finish(
                        runId,
                        if (missed.isEmpty()) SyncLog.Status.SENT else SyncLog.Status.PARTIAL,
                        days = days.size,
                        message = listOfNotNull(
                            "full window".takeIf { fallback },
                            decision.note?.let { applicationContext.getString(it) },
                            "$deleted deleted".takeIf { deleted > 0 },
                            "could not read ${missed.joinToString(", ")}".takeIf { missed.isNotEmpty() },
                        ).joinToString("; ").ifEmpty { null }?.replaceFirstChar { it.uppercase() },
                        from = decision.days.firstOrNull()?.toString(),
                        to = decision.days.lastOrNull()?.toString(),
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
