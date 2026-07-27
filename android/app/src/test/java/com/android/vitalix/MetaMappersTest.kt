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
        // Vo2Max has no MEASUREMENT_METHOD_UNKNOWN constant: 0 is the
        // legitimate "other" value and must be preserved, not dropped.
        val vo2Zero = MetaMappers.vo2MaxMeta(0)
        assertEquals(mapOf("measurementMethod" to "other"), vo2Zero)
        assertEquals(setOf("measurementLocation"), MetaMappers.bodyTemperatureMeta(1)?.keys)
        // BodyTemperature DOES define MEASUREMENT_LOCATION_UNKNOWN = 0, so
        // this stays dropped under the new rule too.
        assertNull(MetaMappers.bodyTemperatureMeta(0))
    }

    @Test fun activityIntensityKnownEnums() {
        // ActivityIntensityRecord (connect-client 1.2.0-alpha04) defines only
        // ACTIVITY_INTENSITY_TYPE_MODERATE = 0 and ..._VIGOROUS = 1 - there is
        // no UNKNOWN sentinel, so 0 is a real value (same pattern as Vo2Max's
        // measurementMethod=0/"other"), not something to omit.
        assertEquals(mapOf("intensityType" to "moderate"), MetaMappers.activityIntensityMeta(0))
        assertEquals(mapOf("intensityType" to "vigorous"), MetaMappers.activityIntensityMeta(1))
    }

    @Test fun mindfulnessMapsSessionTypeAndOmitsUnknown() {
        val m = MetaMappers.mindfulnessMeta(1)
        assertTrue(m != null && m.containsKey("sessionType"))
        assertEquals(mapOf("sessionType" to "meditation"), m)
        assertNull(MetaMappers.mindfulnessMeta(0)) // MINDFULNESS_SESSION_TYPE_UNKNOWN
    }

    @Test fun skinTemperatureCarriesBaselineWhenPresent() {
        val m = MetaMappers.skinTemperatureMeta(1, 33.5)
        assertTrue(m != null)
        assertEquals("33.5", m!!["baseline"])
        assertTrue(m.containsKey("measurementLocation"))
        assertEquals("finger", m["measurementLocation"])
        // Unknown location and no baseline -> nothing known -> null.
        assertNull(MetaMappers.skinTemperatureMeta(0, null))
        // Baseline alone is still "known" even with an unknown location.
        val baselineOnly = MetaMappers.skinTemperatureMeta(0, 34.0)
        assertEquals(mapOf("baseline" to "34.0"), baselineOnly)
    }

    @Test fun basalBodyTemperatureMapsLocation() {
        assertEquals(setOf("measurementLocation"), MetaMappers.basalBodyTemperatureMeta(1)?.keys)
        assertNull(MetaMappers.basalBodyTemperatureMeta(0))
    }

    @Test fun cervicalMucusSensation() {
        val m = MetaMappers.cervicalMucusMeta(1)
        assertTrue(m != null && m.containsKey("sensation"))
        assertEquals(mapOf("sensation" to "light"), m)
        assertNull(MetaMappers.cervicalMucusMeta(0)) // SENSATION_UNKNOWN
    }

    @Test fun mealTypeMapsKnownAndOmitsUnknown() {
        val m = MetaMappers.mealTypeMeta(1)
        assertTrue(m != null)
        assertEquals(mapOf("mealType" to "breakfast"), m)
        assertNull(MetaMappers.mealTypeMeta(0)) // MEAL_TYPE_UNKNOWN
    }
}
