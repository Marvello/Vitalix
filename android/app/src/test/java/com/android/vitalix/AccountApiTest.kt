package com.android.vitalix

import com.android.vitalix.auth.AccountApi
import com.android.vitalix.auth.DeleteResult
import org.json.JSONObject
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.fail

class AccountApiTest {
    @Test fun bodyCarriesPassword() {
        assertEquals("p\"w", JSONObject(AccountApi.deleteBody("p\"w")).getString("password"))
    }

    @Test fun mapsStatuses() {
        assertEquals(DeleteResult.Deleted, AccountApi.mapDelete(204, ""))
        assertEquals(DeleteResult.Deleted, AccountApi.mapDelete(200, "{}"))
        assertEquals(DeleteResult.WrongPassword, AccountApi.mapDelete(403, """{"error":"Wrong password"}"""))
        assertEquals(DeleteResult.Refused("only admin"), AccountApi.mapDelete(409, """{"error":"only admin"}"""))
        assertEquals(DeleteResult.Failed(500, null), AccountApi.mapDelete(500, "<html>"))
        assertEquals(DeleteResult.Refused(null), AccountApi.mapDelete(409, "garbage"))
    }

    @Test fun unauthorizedAfterRefreshMeansSignedOut() {
        // AuthedHttp already tried a refresh; a 401 that still comes back ends the session.
        assertEquals(DeleteResult.SignedOut, AccountApi.mapDelete(401, """{"error":"Unauthorized"}"""))
    }

    @Test fun noServerConfiguredNeverCalls() {
        val never: (String) -> Pair<Int, String> = { fail("must not call without a server") }
        assertEquals(DeleteResult.NoServer, AccountApi.delete(null, never))
        assertEquals(DeleteResult.NoServer, AccountApi.delete("  ", never))
    }

    @Test fun ioFailureIsUnreachable() {
        assertEquals(DeleteResult.Unreachable, AccountApi.delete("https://x") { throw IOException("timeout") })
    }

    @Test fun otherFailureIsGeneric() {
        assertEquals(DeleteResult.Failed(null, null), AccountApi.delete("https://x") { throw IllegalArgumentException("bad url") })
    }

    @Test fun responseIsMapped() {
        assertEquals(DeleteResult.Deleted, AccountApi.delete("https://x") { 204 to "" })
        assertEquals(DeleteResult.SignedOut, AccountApi.delete("https://x") { 401 to "" })
        assertEquals(DeleteResult.Failed(502, null), AccountApi.delete("https://x") { 502 to "" })
    }
}
