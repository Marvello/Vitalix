package com.android.vitalix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DigestCopyTest {
    @Test fun pushTitlePerKind() {
        assertEquals("Your weekly summary is ready", VitalixFirebaseService.digestTitle("week"))
        assertEquals("Your monthly summary is ready", VitalixFirebaseService.digestTitle("month"))
        assertNull(VitalixFirebaseService.digestTitle("year"))
        assertNull(VitalixFirebaseService.digestTitle(null))
    }

    @Test fun screenTitlePerKind() {
        assertEquals("Week of 2026-11-02", InsightActivity.digestTitle("week", "2026-11-02"))
        assertEquals("November 2026", InsightActivity.digestTitle("month", "2026-11-01"))
        assertEquals("Weekly summary", InsightActivity.digestTitle("week", null))
        assertEquals("Monthly summary", InsightActivity.digestTitle("month", "garbage"))
    }
}
