package com.android.vitalix

import android.graphics.drawable.Drawable
import com.google.android.material.button.MaterialButton
import com.google.android.material.progressindicator.CircularProgressIndicatorSpec
import com.google.android.material.progressindicator.IndeterminateDrawable

/**
 * Disables the button and shows an inline spinner while a request runs; restores it after.
 * Call with false from every exit path, including exceptions. The spinner is built once per
 * button (kept in a view tag) and only re-applied when the state changes.
 */
fun MaterialButton.setBusy(busy: Boolean) {
    isEnabled = !busy
    if (!busy) {
        if (icon != null) icon = null
        return
    }
    if (icon != null) return
    icon = (getTag(R.id.tag_busy_spinner) as? Drawable) ?: run {
        val spec = CircularProgressIndicatorSpec(
            context, null, 0, com.google.android.material.R.style.Widget_Material3_CircularProgressIndicator_ExtraSmall
        ).apply { indicatorColors = intArrayOf(textColors.getColorForState(intArrayOf(android.R.attr.state_enabled), currentTextColor)) }
        IndeterminateDrawable.createCircularDrawable(context, spec).also { setTag(R.id.tag_busy_spinner, it) }
    }
    iconTint = null
}
