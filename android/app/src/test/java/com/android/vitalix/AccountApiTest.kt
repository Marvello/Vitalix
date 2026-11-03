package com.android.vitalix

import com.android.vitalix.auth.AccountApi
import com.android.vitalix.auth.DeleteResult
import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals

class AccountApiTest {
    @Test fun bodyCarriesPassword() {
        assertEquals("p\"w", JSONObject(AccountApi.deleteBody("p\"w")).getString("password"))
    }

    @Test fun mapsStatuses() {
        assertEquals(DeleteResult.Deleted, AccountApi.mapDelete(204, ""))
        assertEquals(DeleteResult.Deleted, AccountApi.mapDelete(200, "{}"))
        assertEquals(DeleteResult.WrongPassword, AccountApi.mapDelete(403, """{"error":"Wrong password"}"""))
        assertEquals(DeleteResult.Refused("only admin"), AccountApi.mapDelete(409, """{"error":"only admin"}"""))
        assertEquals(DeleteResult.Failed("Request failed (500)."), AccountApi.mapDelete(500, "<html>"))
        assertEquals(DeleteResult.Refused("Account can't be deleted right now."), AccountApi.mapDelete(409, "garbage"))
    }
}
