package com.android.vitalix

import android.content.Context
import android.text.InputType
import android.widget.EditText
import android.widget.FrameLayout
import androidx.appcompat.app.AlertDialog

/**
 * Modal for changing the receiver URL. Which server a build points at is decided
 * at build time; this is the escape hatch for pointing one build somewhere else,
 * so it lives behind a dialog rather than sitting in the sign-in form and the
 * sync screen where it invited edits during normal use.
 */
object ServerUrlDialog {

    fun show(context: Context, settings: SyncSettings, onSaved: (String?) -> Unit) {
        val input = EditText(context).apply {
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(settings.serverUrl ?: "")
            hint = settings.defaultServerUrl ?: "https://your-server/api/health"
            setSingleLine()
        }
        // Inset so the field isn't flush against the dialog edges.
        val pad = (context.resources.displayMetrics.density * 20).toInt()
        val container = FrameLayout(context).apply {
            setPadding(pad, pad / 2, pad, 0)
            addView(input)
        }

        val builder = AlertDialog.Builder(context)
            .setTitle("Server URL")
            .setView(container)
            .setPositiveButton("Save") { _, _ ->
                settings.serverUrl = input.text?.toString()
                onSaved(settings.serverUrl)
            }
            .setNegativeButton("Cancel", null)

        // Only worth offering when there's a build default to fall back to.
        if (settings.defaultServerUrl != null) {
            builder.setNeutralButton("Use default") { _, _ ->
                settings.resetServerUrl()
                onSaved(settings.serverUrl)
            }
        }
        builder.show()
    }
}
