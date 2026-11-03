package com.android.vitalix

import com.android.vitalix.models.ExportConfig
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SyncSettingsMappingTest {
    @Test fun newFlagsRoundTripThroughMap() {
        val cfg = ExportConfig(includeSkinTemperature = true, includeMindfulness = true, includeNutritionDetail = true, includeExerciseRoute = true)
        val restored = SyncSettings.mapToConfig(SyncSettings.configToMap(cfg))
        assertTrue(restored.includeSkinTemperature)
        assertTrue(restored.includeMindfulness)
        assertTrue(restored.includeNutritionDetail)
        assertTrue(restored.includeExerciseRoute)
    }

    @Test fun roundTripsConfigFlags() {
        val cfg = ExportConfig(includeSteps = true, includeHeartRate = true, includeWeight = true, daysBack = 14, saferExportMode = true)
        val restored = SyncSettings.mapToConfig(SyncSettings.configToMap(cfg))
        assertEquals(cfg, restored)
    }

    @Test fun defaultsWhenKeysMissing() {
        val cfg = SyncSettings.mapToConfig(emptyMap())
        assertEquals(false, cfg.includeSteps)
        assertEquals(7, cfg.daysBack)
    }

    @Test fun changesTokenOnlyCountsForTheSameGrantedTypes() {
        val key = SyncSettings.typesKey(listOf("WeightRecord", "StepsRecord"))
        assertEquals("StepsRecord,WeightRecord", key)
        assertEquals("tok", SyncSettings.validChangesToken("tok", key, "StepsRecord,WeightRecord"))
        // A permission added or revoked since the token was taken: it no longer counts.
        assertEquals(null, SyncSettings.validChangesToken("tok", key, "StepsRecord"))
        assertEquals(null, SyncSettings.validChangesToken(null, key, key))
        assertEquals(null, SyncSettings.validChangesToken("tok", key, ""))
    }
}
