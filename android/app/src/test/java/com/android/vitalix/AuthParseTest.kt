package com.android.vitalix

import com.android.vitalix.auth.AuthClient
import kotlin.test.Test
import kotlin.test.assertEquals

class AuthParseTest {
    @Test fun parsesTokens() {
        val t = AuthClient.parseTokens("""{"access":"a.b.c","refresh":"r1","user":{"id":1}}""")
        assertEquals("a.b.c", t.access); assertEquals("r1", t.refresh)
    }
    @Test fun derivesAuthBaseFromSyncUrl() {
        assertEquals("http://10.0.2.2:3000", AuthClient.authBaseFrom("http://10.0.2.2:3000/api/health"))
        assertEquals("https://vitalix.example.com", AuthClient.authBaseFrom("https://vitalix.example.com/api/health"))
    }
}
