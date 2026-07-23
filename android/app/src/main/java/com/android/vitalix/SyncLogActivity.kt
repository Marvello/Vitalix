package com.android.vitalix

import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.work.WorkManager
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

/** Read-only history of sync runs: kind, when, outcome, and the dates covered. */
class SyncLogActivity : AppCompatActivity() {

    private val log by lazy { SyncLog(this) }
    private val stamp = SimpleDateFormat("MMM d, HH:mm", Locale.getDefault())

    private lateinit var list: LinearLayout
    private lateinit var empty: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_sync_log)
        list = findViewById(R.id.listEntries)
        empty = findViewById(R.id.txtEmpty)
        findViewById<Button>(R.id.btnClearLog).setOnClickListener {
            log.clear()
            render()
        }
    }

    // Re-read on resume so a sync started from the previous screen shows up.
    override fun onResume() {
        super.onResume()
        reconcileThenRender()
    }

    /**
     * Ask WorkManager whether a backfill is genuinely still in flight before the
     * log writes off anything left on "Running".
     */
    private fun reconcileThenRender() {
        val future = WorkManager.getInstance(this)
            .getWorkInfosForUniqueWork(BackfillWorker.NAME)
        future.addListener({
            val active = try {
                future.get().any { !it.state.isFinished }
            } catch (_: Exception) {
                false
            }
            runOnUiThread {
                log.reconcile(active)
                render(active)
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun render(backfillActive: Boolean = false) {
        val entries = log.entries()
        empty.visibility = if (entries.isEmpty()) View.VISIBLE else View.GONE
        list.removeAllViews()
        val inflater = LayoutInflater.from(this)
        entries.forEach { e ->
            val row = inflater.inflate(R.layout.item_sync_log, list, false)
            row.findViewById<TextView>(R.id.txtKind).text = e.kind.label
            row.findViewById<TextView>(R.id.txtStatus).apply {
                text = e.status.label
                setTextColor(colorFor(e.status))
            }
            row.findViewById<TextView>(R.id.txtWhen).text = whenText(e)
            row.findViewById<TextView>(R.id.txtPeriod).text = periodText(e)
            // Only a full-history run is stoppable: it's the one that runs in
            // WorkManager. A manual sync lives and dies with its screen.
            val stoppable = backfillActive &&
                e.kind == SyncLog.Kind.FULL && e.status == SyncLog.Status.RUNNING
            row.findViewById<Button>(R.id.btnCancelRun).apply {
                visibility = if (stoppable) View.VISIBLE else View.GONE
                setOnClickListener { confirmStop(e.id) }
            }
            row.findViewById<TextView>(R.id.txtMessage).apply {
                if (e.message.isNullOrBlank()) {
                    visibility = View.GONE
                } else {
                    visibility = View.VISIBLE
                    text = e.message
                }
            }
            list.addView(row)
        }
    }

    /**
     * Stopping discards nothing already sent — the server keeps every slice that
     * landed — but the next run restarts from today rather than resuming, so it
     * is worth a confirmation.
     */
    private fun confirmStop(id: String) {
        AlertDialog.Builder(this)
            .setTitle("Stop full history sync?")
            .setMessage("Days already sent stay on the server. Starting again begins from today.")
            .setPositiveButton("Stop") { _, _ ->
                BackfillWorker.cancel(this)
                log.finish(id, SyncLog.Status.FAILED, message = "Stopped")
                reconcileThenRender()
            }
            .setNegativeButton("Keep running", null)
            .show()
    }

    private fun whenText(e: SyncLog.Entry): String {
        val started = stamp.format(Date(e.startedAt))
        val finished = e.finishedAt ?: return "Started $started"
        val seconds = TimeUnit.MILLISECONDS.toSeconds(finished - e.startedAt)
        val took = if (seconds >= 60) "${seconds / 60}m ${seconds % 60}s" else "${seconds}s"
        return "$started · took $took"
    }

    private fun periodText(e: SyncLog.Entry): String {
        val range = when {
            e.from != null && e.to != null && e.from == e.to -> e.from
            // A run that failed on its first slice can end up with from after to.
            e.from != null && e.to != null && e.from > e.to -> e.to
            e.from != null && e.to != null -> "${e.from} → ${e.to}"
            // A backfill in flight knows where it ends before where it starts.
            e.to != null -> "up to ${e.to}"
            e.from != null -> "from ${e.from}"
            else -> "—"
        }
        // Days sent is only meaningful once a run has finished.
        // A running backfill reports days as it goes; other runs only at the end.
        val days = if (e.status == SyncLog.Status.RUNNING && e.days == 0) "" else " · ${e.days} days"
        return "Period: $range$days"
    }

    private fun colorFor(status: SyncLog.Status) = when (status) {
        SyncLog.Status.SENT -> Color.parseColor("#0FA9A0")
        SyncLog.Status.PARTIAL -> Color.parseColor("#B45309")
        SyncLog.Status.FAILED -> Color.parseColor("#B91C1C")
        SyncLog.Status.RUNNING -> Color.parseColor("#64748B")
    }
}
