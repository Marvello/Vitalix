package com.android.vitalix.models

data class DailyHealthData(
    val date: String,
    val activityData: Map<String, Any?> = emptyMap(),
    val bodyMeasurementData: Map<String, Any?> = emptyMap(),
    val cycleTrackingData: Map<String, Any?> = emptyMap(),
    val nutritionData: Map<String, Any?> = emptyMap(),
    val sleepData: Map<String, Any?> = emptyMap(),
    val vitalsData: Map<String, Any?> = emptyMap(),
    val exercises: List<ExerciseData> = emptyList(),
    val samples: List<HealthSample> = emptyList()
)

data class ExerciseData(
    val date: String,
    val startDateTime: String,
    val exerciseName: String,
    val durationMinutes: Long,
    /** Health Connect package that wrote the record (e.g. com.google.android.apps.fitness). */
    val source: String? = null,
    /** Health Connect record UID (metadata.id), for idempotent server storage. */
    val hcId: String? = null
)

data class BodyMeasurementData(
    val dateTime: String,
    val weight: String?,
    val bodyFat: String?
)

data class HealthSample(
    val metric: String,
    val start: String,
    val end: String? = null,
    val value: Double? = null,
    val value2: Double? = null,
    val text: String? = null,
    /** Health Connect package that wrote the record (the originating app). */
    val source: String? = null,
    /** Health Connect record UID (metadata.id), for idempotent server storage. */
    val hcId: String? = null,
    /**
     * Per-reading context enums Health Connect attaches (e.g. a blood-pressure
     * reading's body position). Null/empty when the record has no context.
     */
    val meta: Map<String, String>? = null
)

data class ExportConfig(
    // Activity
    val includeActiveCalories: Boolean = false,
    val includeDistance: Boolean = false,
    val includeElevationGained: Boolean = false,
    val includeExercise: Boolean = false,
    val includeFloorsClimbed: Boolean = false,
    val includePower: Boolean = false,
    val includeSpeed: Boolean = false,
    val includeSteps: Boolean = false,
    val includeTotalCalories: Boolean = false,
    val includeVO2Max: Boolean = false,
    val includeWheelchairPushes: Boolean = false,

    // Body Measurements
    val includeBodyFat: Boolean = false,
    val includeBoneMass: Boolean = false,
    val includeHeight: Boolean = false,
    val includeLeanBodyMass: Boolean = false,
    val includeWeight: Boolean = false,

    // Cycle Tracking
    val includeCervicalMucus: Boolean = false,
    val includeMenstruation: Boolean = false,
    val includeOvulationTest: Boolean = false,
    val includeSexualActivity: Boolean = false,

    // Nutrition
    val includeHydration: Boolean = false,
    val includeNutrition: Boolean = false,

    // Sleep
    val includeSleepSession: Boolean = false,

    // Vitals
    val includeBloodGlucose: Boolean = false,
    val includeBloodPressure: Boolean = false,
    val includeBodyTemperature: Boolean = false,
    val includeHeartRate: Boolean = false,
    val includeHeartRateVariability: Boolean = false,
    val includeOxygenSaturation: Boolean = false,
    val includeRespiratoryRate: Boolean = false,
    val includeRestingHeartRate: Boolean = false,

    val daysBack: Int = 7,
    val saferExportMode: Boolean = false,
    val autoSync: Boolean = false
)

data class MinMaxAvg(
    val min: Double? = null,
    val max: Double? = null,
    val avg: Double? = null
)
