package com.android.vitalix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AnomalyCopyTest {
    @Test fun mapsEachRuleToItsCopyAndArgs() {
        val f = VitalixFirebaseService.Companion
        assertEquals(R.string.alert_rhr_up to listOf("72", "60"), f.anomalyCopy("rhr_up", "72", "60"))
        assertEquals(R.string.alert_hrv_drop to listOf("30", "50"), f.anomalyCopy("hrv_drop", "30", "50"))
        assertEquals(R.string.alert_spo2_low to listOf("88"), f.anomalyCopy("spo2_low", "88", ""))
        assertEquals(R.string.alert_bp_high to listOf("142/91"), f.anomalyCopy("bp_high", "142/91", ""))
    }

    @Test fun unknownOrMissingRuleIsSilent() {
        assertNull(VitalixFirebaseService.anomalyCopy("nope", "1", ""))
        assertNull(VitalixFirebaseService.anomalyCopy(null, "1", ""))
    }
}
