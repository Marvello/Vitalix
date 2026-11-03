package com.android.vitalix.widget

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

/** 2x1 home-screen widget; event-driven (updatePeriodMillis = 0), redrawn by [refresh]. */
class VitalixWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { manager.updateAppWidget(it, build(context)) }
    }

    companion object {
        fun refresh(context: Context) {
            val mgr = AppWidgetManager.getInstance(context)
            val ids = mgr.getAppWidgetIds(ComponentName(context, VitalixWidget::class.java))
            if (ids.isNotEmpty()) mgr.updateAppWidget(ids, build(context))
        }

        fun build(context: Context): RemoteViews {
            val s = WidgetState.load(context)
            val v = RemoteViews(context.packageName, R.layout.widget_vitalix)
            val status = WidgetState.statusLine(s).ifEmpty { context.getString(R.string.widget_no_sync) }
            v.setTextViewText(R.id.widget_status, status)
            v.setTextViewText(R.id.widget_steps, s?.stepsToday?.let { NumberFormat.getIntegerInstance().format(it) } ?: "—")
            v.setTextViewText(R.id.widget_sleep, WidgetState.sleepText(s?.sleepLastNightMin))
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
