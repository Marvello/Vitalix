package com.android.vitalix.health

import androidx.health.connect.client.records.ActivityIntensityRecord
import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.BodyTemperatureMeasurementLocation
import androidx.health.connect.client.records.CervicalMucusRecord
import androidx.health.connect.client.records.MealType
import androidx.health.connect.client.records.MindfulnessSessionRecord
import androidx.health.connect.client.records.SkinTemperatureRecord
import androidx.health.connect.client.records.Vo2MaxRecord

/**
 * Pure Health-Connect-enum → context-map mappers. Kept free of HC record
 * construction so they unit-test with plain Int inputs. An unmapped or
 * *_UNKNOWN (0) enum is omitted; an all-unknown reading yields null.
 *
 * Each lookup uses HC's public `*_INT_TO_STRING_MAP` where accessible in
 * connect-client 1.2.0-alpha04 (as HealthConnectManager already does for
 * flow/appearance/etc.); where a map is not public, a local map with the
 * documented enum strings is substituted. The produced KEY names are the
 * cross-component contract and must not change.
 *
 * Not every enum has an UNKNOWN sentinel: ActivityIntensityRecord's type
 * (MODERATE=0, VIGOROUS=1) has none, so 0 is a real value, not "unknown" —
 * same shape as Vo2MaxRecord's measurementMethod.
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

    fun activityIntensityMeta(type: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        // ActivityIntensityRecord defines no UNKNOWN sentinel: MODERATE = 0 is
        // a legitimate value (same shape as Vo2Max's measurementMethod), so
        // putIfKnown's "unknown"-string filter is a no-op here by design.
        putIfKnown(out, "intensityType", ActivityIntensityRecord.ACTIVITY_INTENSITY_TYPE_INT_TO_STRING_MAP, type)
        return nullIfEmpty(out)
    }

    fun mindfulnessMeta(type: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "sessionType", MindfulnessSessionRecord.MINDFULNESS_SESSION_TYPE_INT_TO_STRING_MAP, type)
        return nullIfEmpty(out)
    }

    fun skinTemperatureMeta(location: Int, baselineCelsius: Double?): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "measurementLocation", SkinTemperatureRecord.MEASUREMENT_LOCATION_INT_TO_STRING_MAP, location)
        baselineCelsius?.let { out["baseline"] = it.toString() }
        return nullIfEmpty(out)
    }

    fun basalBodyTemperatureMeta(location: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        // BasalBodyTemperatureRecord shares the common BodyTemperatureMeasurementLocation
        // enum space (no record-specific *_INT_TO_STRING_MAP of its own).
        putIfKnown(out, "measurementLocation", BodyTemperatureMeasurementLocation.MEASUREMENT_LOCATION_INT_TO_STRING_MAP, location)
        return nullIfEmpty(out)
    }

    fun cervicalMucusMeta(sensation: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "sensation", CervicalMucusRecord.SENSATION_INT_TO_STRING_MAP, sensation)
        return nullIfEmpty(out)
    }

    fun mealTypeMeta(mealType: Int): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        putIfKnown(out, "mealType", MealType.MEAL_TYPE_INT_TO_STRING_MAP, mealType)
        return nullIfEmpty(out)
    }
}
