package com.android.vitalix

import org.json.JSONObject
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

class JournalApiTest {
    @Test fun numericBodyHasNoDayOrText() {
        val o = JSONObject(JournalApi.postBody("mood", num = 4, loggedAt = Instant.parse("2026-11-03T18:30:00Z")))
        assertEquals("mood", o.getString("kind"))
        assertEquals(4, o.getInt("value_num"))
        assertEquals("2026-11-03T18:30:00Z", o.getString("logged_at"))
        assertFalse(o.has("day")); assertFalse(o.has("value_text"))
    }

    @Test fun textBodyIsTrimmed() {
        val o = JSONObject(JournalApi.postBody("symptom", text = "  sore throat "))
        assertEquals("sore throat", o.getString("value_text"))
        assertFalse(o.has("value_num"))
    }

    @Test fun parsesEntriesWithNulls() {
        val list = JournalApi.parseEntries("""{"entries":[
            {"id":7,"kind":"caffeine","value_num":2,"value_text":null},
            {"id":8,"kind":"symptom","value_num":null,"value_text":"headache"}]}""")
        assertEquals(listOf(7L, 8L), list.map { it.id })
        assertEquals("Caffeine 2 cups", list[0].label())
        assertNull(list[1].valueNum)
        assertEquals("Symptom: headache", list[1].label())
    }
}
