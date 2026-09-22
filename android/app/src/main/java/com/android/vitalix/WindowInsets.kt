package com.android.vitalix

import android.app.Activity
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding

fun Activity.applyStatusBarTopPadding(view: View? = null) {
    val target = view ?: findViewById<View>(android.R.id.content).let {
        (it as? android.view.ViewGroup)?.getChildAt(0) ?: it
    }
    val basePadding = target.paddingTop
    ViewCompat.setOnApplyWindowInsetsListener(target) { v, insets ->
        val top = insets.getInsets(WindowInsetsCompat.Type.statusBars()).top
        v.updatePadding(top = basePadding + top)
        insets
    }
    ViewCompat.requestApplyInsets(target)
}

/**
 * Pads the root content view for BOTH the status bar (top) and the
 * navigation bar (bottom) so edge-to-edge screens don't draw under the
 * system bars. targetSdk 37 enforces edge-to-edge, so every screen without
 * its own inset handling needs this.
 */
fun Activity.applySystemBarsPadding(view: View? = null) {
    val target = view ?: findViewById<View>(android.R.id.content).let {
        (it as? android.view.ViewGroup)?.getChildAt(0) ?: it
    }
    val baseTop = target.paddingTop
    val baseBottom = target.paddingBottom
    ViewCompat.setOnApplyWindowInsetsListener(target) { v, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
        v.updatePadding(top = baseTop + bars.top, bottom = baseBottom + bars.bottom)
        insets
    }
    ViewCompat.requestApplyInsets(target)
}
