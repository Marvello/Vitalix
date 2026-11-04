package com.android.vitalix

import android.graphics.drawable.Drawable
import com.google.android.material.button.MaterialButton
import com.google.android.material.progressindicator.CircularProgressIndicatorSpec
import com.google.android.material.progressindicator.IndeterminateDrawable

/**
 * Disables the button and shows an inline spinner while a request runs; restores it (and any
 * icon it had) after. Call with false from every exit path, including exceptions. The spinner is
 * built once per button and kept in a view tag; busy is "the icon is that spinner", so repeated
 * calls with the same state do nothing.
 */
fun MaterialButton.setBusy(busy: Boolean) {
    isEnabled = !busy
    val spinner = getTag(R.id.tag_busy_spinner) as? Drawable
    val isBusy = spinner != null && icon === spinner
    if (!busy) {
        if (isBusy) {
            icon = getTag(R.id.tag_busy_prev_icon) as? Drawable
            setTag(R.id.tag_busy_prev_icon, null)
        }
        return
    }
    if (isBusy) return
    setTag(R.id.tag_busy_prev_icon, icon)
    // Busy means disabled, so currentTextColor is the disabled label colour: visible on the
    // 12% onSurface disabled fill in both themes (white would vanish on it in light mode).
    val s = spinner ?: run {
        val spec = CircularProgressIndicatorSpec(
            context, null, 0, com.google.android.material.R.style.Widget_Material3_CircularProgressIndicator_ExtraSmall
        ).apply { indicatorColors = intArrayOf(currentTextColor) }
        IndeterminateDrawable.createCircularDrawable(context, spec).also { setTag(R.id.tag_busy_spinner, it) }
    }
    icon = s
    iconTint = null
}
