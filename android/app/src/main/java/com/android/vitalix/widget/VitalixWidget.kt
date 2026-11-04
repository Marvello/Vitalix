package com.android.vitalix.widget

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import com.android.vitalix.InsightActivity
import com.android.vitalix.MainActivity
import com.android.vitalix.R
import java.text.NumberFormat
import java.time.LocalDate
import java.time.ZonedDateTime

/** 2x1 home-screen widget; event-driven (updatePeriodMillis = 0), redrawn by [refresh]. */
class VitalixWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { manager.updateAppWidget(it, build(context)) }
        scheduleMidnightRefresh(context, ids)
    }

    /** Last widget removed: nothing left to redraw at midnight. */
    override fun onDisabled(context: Context) {
        context.getSystemService(AlarmManager::class.java).cancel(midnightIntent(context, intArrayOf()))
    }

    companion object {
        fun refresh(context: Context) {
            val mgr = AppWidgetManager.getInstance(context)
            val ids = mgr.getAppWidgetIds(ComponentName(context, VitalixWidget::class.java))
            if (ids.isNotEmpty()) {
                mgr.updateAppWidget(ids, build(context))
                scheduleMidnightRefresh(context, ids)
            }
        }

        /** One minute past the next local midnight, so "today" has rolled over when the redraw runs. */
        fun nextRefreshAt(now: ZonedDateTime): Long =
            now.toLocalDate().plusDays(1).atStartOfDay(now.zone).plusMinutes(1).toInstant().toEpochMilli()

        private fun midnightIntent(context: Context, ids: IntArray) = PendingIntent.getBroadcast(
            context, 0,
            Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE, null, context, VitalixWidget::class.java)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        /** Inexact on purpose: no exact-alarm permission, and a few minutes' lateness is harmless. */
        private fun scheduleMidnightRefresh(context: Context, ids: IntArray) {
            context.getSystemService(AlarmManager::class.java)
                .set(AlarmManager.RTC, nextRefreshAt(ZonedDateTime.now()), midnightIntent(context, ids))
        }

        fun build(context: Context): RemoteViews {
            val s = WidgetState.load(context)
            val shown = WidgetState.current(s, LocalDate.now())
            val v = RemoteViews(context.packageName, R.layout.widget_vitalix)
            val empty = context.getString(R.string.widget_empty)
            val status = WidgetState.statusLine(s, WidgetState.StatusText(
                context.getString(R.string.widget_sent_at), context.getString(R.string.widget_partial_at),
                context.getString(R.string.widget_failed_retry))).ifEmpty { context.getString(R.string.widget_no_sync) }
            v.setTextViewText(R.id.widget_status, status)
            v.setTextViewText(R.id.widget_steps, shown?.stepsToday?.let { NumberFormat.getIntegerInstance().format(it) } ?: empty)
            v.setTextViewText(R.id.widget_sleep, WidgetState.sleepText(shown?.sleepLastNightMin, context.getString(R.string.widget_sleep_value), empty))
            val insight = s?.insightReadyDay == LocalDate.now().minusDays(1).toString()
            v.setViewVisibility(R.id.widget_insight, if (insight) View.VISIBLE else View.GONE)
            v.setOnClickPendingIntent(R.id.widget_root, activity(context, 1, Intent(context, MainActivity::class.java)))
            v.setOnClickPendingIntent(R.id.widget_insight, activity(context, 2, InsightActivity.intent(context, s?.insightReadyDay)))
            return v
        }

        private fun activity(ctx: Context, code: Int, intent: Intent) = PendingIntent.getActivity(
            ctx, code, intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
