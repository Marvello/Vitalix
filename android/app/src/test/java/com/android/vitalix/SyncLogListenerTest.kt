package com.android.vitalix

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

class SyncLogListenerTest {
    @After fun reset() { SyncLog.outcomeListener = null }

    @Test fun nullListenerIsNoOp() {
        SyncLog.outcomeListener = null
        SyncLog.notifyOutcome(SyncLog.Status.SENT)
    }

    @Test fun throwingListenerDoesNotPropagate() {
        var calls = 0
        SyncLog.outcomeListener = { calls++; error("boom") }
        SyncLog.notifyOutcome(SyncLog.Status.FAILED)
        assertEquals(1, calls)
    }

    @Test fun listenerReceivesStatus() {
        var got: SyncLog.Status? = null
        SyncLog.outcomeListener = { got = it }
        SyncLog.notifyOutcome(SyncLog.Status.PARTIAL)
        assertEquals(SyncLog.Status.PARTIAL, got)
    }
}
