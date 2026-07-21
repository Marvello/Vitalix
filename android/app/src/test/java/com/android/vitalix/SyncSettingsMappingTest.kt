package com.android.vitalix

import com.android.vitalix.models.ExportConfig
import kotlin.test.Test
import kotlin.test.assertEquals

class SyncSettingsMappingTest {
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
}
