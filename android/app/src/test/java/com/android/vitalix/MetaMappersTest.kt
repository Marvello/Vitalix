package com.android.vitalix

import com.android.vitalix.health.MetaMappers
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.assertFalse

class MetaMappersTest {
    @Test fun bloodPressureMapsKnownEnumsAndOmitsUnknown() {
        // Any non-zero known enum ints; 0 is the *_UNKNOWN sentinel across HC.
        val m = MetaMappers.bloodPressureMeta(bodyPosition = 1, measurementLocation = 1)
        assertTrue(m != null && m.containsKey("bodyPosition"))
        assertTrue(m.containsKey("measurementLocation"))
        // Unknown (0) for both -> null map.
        assertNull(MetaMappers.bloodPressureMeta(bodyPosition = 0, measurementLocation = 0))
        // One known, one unknown -> only the known key present.
        val one = MetaMappers.bloodPressureMeta(bodyPosition = 1, measurementLocation = 0)
        assertTrue(one != null && one.containsKey("bodyPosition"))
        assertFalse(one.containsKey("measurementLocation"))
    }

    @Test fun bloodGlucoseKeysAreContractual() {
        val m = MetaMappers.bloodGlucoseMeta(mealType = 1, relationToMeal = 1, specimenSource = 1)
        assertTrue(m != null)
        assertTrue(m.keys.all { it in setOf("mealType", "relationToMeal", "specimenSource") })
        assertNull(MetaMappers.bloodGlucoseMeta(0, 0, 0))
    }

    @Test fun vo2AndBodyTempSingleKey() {
        assertEquals(setOf("measurementMethod"), MetaMappers.vo2MaxMeta(1)?.keys)
        assertNull(MetaMappers.vo2MaxMeta(0))
        assertEquals(setOf("measurementLocation"), MetaMappers.bodyTemperatureMeta(1)?.keys)
        assertNull(MetaMappers.bodyTemperatureMeta(0))
    }
}
