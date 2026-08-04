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
