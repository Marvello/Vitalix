package com.android.vitalix.health

import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.BodyTemperatureMeasurementLocation
import androidx.health.connect.client.records.MealType
import androidx.health.connect.client.records.Vo2MaxRecord

/**
 * Pure Health-Connect-enum → context-map mappers. Kept free of HC record
 * construction so they unit-test with plain Int inputs. An unmapped or
 * *_UNKNOWN (0) enum is omitted; an all-unknown reading yields null.
 *
 * Each lookup uses HC's public `*_INT_TO_STRING_MAP` where accessible in
 * connect-client 1.1.0-alpha07 (as HealthConnectManager already does for
 * flow/appearance/etc.); where a map is not public, a local map with the
 * documented enum strings is substituted. The produced KEY names are the
 * cross-component contract and must not change.
 */
object MetaMappers {
    private fun putIfKnown(out: MutableMap<String, String>, key: String, map: Map<Int, String>, value: Int) {
        // Omit genuine "unknown" sentinels: either absent from HC's map or
        // explicitly mapped to "unknown" (e.g. MealType[0]). Keep real values
        // that happen to be encoded as 0 — Vo2Max measurementMethod=0 is OTHER,
        // not unknown, and Vitalix forwards it faithfully.
        map[value]?.takeIf { it != "unknown" }?.let { out[key] = it }
    }

    private fun nullIfEmpty(m: MutableMap<String, String>): Map<String, String>? =
        if (m.isEmpty()) null else m

    fun bloodPressureMeta(bodyPosition: Int, measurementLocation: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "bodyPosition", BloodPressureRecord.BODY_POSITION_INT_TO_STRING_MAP, bodyPosition)
        putIfKnown(out, "measurementLocation", BloodPressureRecord.MEASUREMENT_LOCATION_INT_TO_STRING_MAP, measurementLocation)
        return nullIfEmpty(out)
    }

    fun bloodGlucoseMeta(mealType: Int, relationToMeal: Int, specimenSource: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "mealType", MealType.MEAL_TYPE_INT_TO_STRING_MAP, mealType)
        putIfKnown(out, "relationToMeal", BloodGlucoseRecord.RELATION_TO_MEAL_INT_TO_STRING_MAP, relationToMeal)
        putIfKnown(out, "specimenSource", BloodGlucoseRecord.SPECIMEN_SOURCE_INT_TO_STRING_MAP, specimenSource)
        return nullIfEmpty(out)
    }

    fun vo2MaxMeta(measurementMethod: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "measurementMethod", Vo2MaxRecord.MEASUREMENT_METHOD_INT_TO_STRING_MAP, measurementMethod)
        return nullIfEmpty(out)
    }

    fun bodyTemperatureMeta(measurementLocation: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "measurementLocation", BodyTemperatureMeasurementLocation.MEASUREMENT_LOCATION_INT_TO_STRING_MAP, measurementLocation)
        return nullIfEmpty(out)
    }
}
