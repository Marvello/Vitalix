package com.android.vitalix

import android.graphics.Color
import com.google.android.material.button.MaterialButton
import com.google.android.material.progressindicator.CircularProgressIndicatorSpec
import com.google.android.material.progressindicator.IndeterminateDrawable

/**
 * Disables the button and shows an inline spinner while a request runs; restores it after.
 * Call with false from every exit path, including exceptions.
 */
fun MaterialButton.setBusy(busy: Boolean) {
    isEnabled = !busy
    if (!busy) {
        icon = null
        return
    }
    val spec = CircularProgressIndicatorSpec(
        context, null, 0, com.google.android.material.R.style.Widget_Material3_CircularProgressIndicator_ExtraSmall
    ).apply { indicatorColors = intArrayOf(Color.WHITE) }
    icon = IndeterminateDrawable.createCircularDrawable(context, spec)
    iconTint = null
}
