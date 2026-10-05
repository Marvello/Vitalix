package com.android.vitalix

import com.android.vitalix.auth.AuthClient
import com.android.vitalix.auth.AuthedHttp
import com.android.vitalix.auth.Tokens
import org.junit.Test
import java.io.IOException
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AuthedHttpTest {
    private var cleared = false
    private var saved: Tokens? = null
    private var refreshCalls = 0

    private fun next(sent: String?, current: String?, refresh: String?, result: Result<Tokens>) =
        AuthedHttp.nextAccessToken(
            sent, current, refresh,
            refresh = { refreshCalls++; result },
            save = { saved = it },
            clear = { cleared = true },
        )

    @Test
    fun `token already refreshed by another request is reused without refreshing`() {
        assertEquals("new", next("old", "new", "r", Result.success(Tokens("x", "y"))))
        assertEquals(0, refreshCalls)
    }

    @Test
    fun `successful refresh saves and returns the new access token`() {
        assertEquals("a2", next("a1", "a1", "r1", Result.success(Tokens("a2", "r2"))))
        assertEquals(Tokens("a2", "r2"), saved)
        assertFalse(cleared)
    }

    @Test
    fun `server rejecting the refresh token clears the session`() {
        assertNull(next("a1", "a1", "r1", Result.failure(AuthClient.AuthException(401, "invalid"))))
        assertTrue(cleared)
    }

    @Test
    fun `network error during refresh keeps the session`() {
        assertNull(next("a1", "a1", "r1", Result.failure(IOException("timeout"))))
        assertFalse(cleared)
    }
}
