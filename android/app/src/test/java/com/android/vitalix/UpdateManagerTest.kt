package com.android.vitalix

import org.json.JSONObject
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class UpdateManagerTest {

    @Test
    fun `parseUpdateInfo extracts all fields from flat response`() {
        val json = JSONObject("""
            {
                "install_url": "https://zealot.example/download/42",
                "build_version": "5",
                "version": "1.2.0",
                "changelog": "### Fixes\n- Fixed date display\n- Improved sync"
            }
        """)
        val info = UpdateManager.parseUpdateInfo(json, currentVersionCode = 3)
        assertEquals("1.2.0", info!!.versionName)
        assertEquals(5, info.versionCode)
        assertEquals("### Fixes\n- Fixed date display\n- Improved sync", info.changelog)
        assertEquals("https://zealot.example/download/42", info.downloadUrl)
    }

    @Test
    fun `parseUpdateInfo falls back to releases array`() {
        val json = JSONObject("""
            {
                "install_url": "",
                "build_version": "",
                "releases": [{
                    "install_url": "https://zealot.example/download/99",
                    "build_version": "7",
                    "version": "2.0.0",
                    "changelog": "Big release"
                }]
            }
        """)
        val info = UpdateManager.parseUpdateInfo(json, currentVersionCode = 3)
        assertEquals("2.0.0", info!!.versionName)
        assertEquals(7, info.versionCode)
        assertEquals("Big release", info.changelog)
    }

    @Test
    fun `parseUpdateInfo returns null when version not newer`() {
        val json = JSONObject("""
            {
                "install_url": "https://zealot.example/download/42",
                "build_version": "3",
                "version": "1.0.0",
                "changelog": ""
            }
        """)
        val info = UpdateManager.parseUpdateInfo(json, currentVersionCode = 3)
        assertNull(info)
    }

    @Test
    fun `parseUpdateInfo returns null when download url blank`() {
        val json = JSONObject("""
            {
                "install_url": "",
                "build_version": "5",
                "version": "1.2.0",
                "changelog": "stuff"
            }
        """)
        val info = UpdateManager.parseUpdateInfo(json, currentVersionCode = 3)
        assertNull(info)
    }

    @Test
    fun `parseUpdateInfo uses build_version as fallback versionName`() {
        val json = JSONObject("""
            {
                "install_url": "https://zealot.example/download/42",
                "build_version": "5",
                "changelog": "no version field"
            }
        """)
        val info = UpdateManager.parseUpdateInfo(json, currentVersionCode = 3)
        assertEquals("5", info!!.versionName)
    }
}
