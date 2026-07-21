package com.android.vitalix.health

import com.android.vitalix.models.MinMaxAvg
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Pure aggregation helpers, unit-tested off-device. No Android/Health Connect
 * dependencies so they run on the host JVM.
 */
object Aggregation {
    fun minMaxAvg(values: List<Double>): MinMaxAvg =
        if (values.isEmpty()) MinMaxAvg()
        else MinMaxAvg(values.min(), values.max(), values.average())

    fun bucketByDay(instant: Instant, zone: ZoneId): LocalDate =
        instant.atZone(zone).toLocalDate()
}
