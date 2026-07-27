# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Vitalix is an Android app that reads Health Connect data on-device and **forwards it as JSON to a user-controlled server** (webhook + optional bearer token). Privacy-first, self-hosted — no Google Sheets, no CSV, no third-party data path.

It is a re-target of the upstream `teqxnology/healthexport` app, swapping the Google Sheets/CSV export destination for a generic HTTP `POST`.

Read `docs/superpowers/specs/2026-07-21-vitalix-health-forwarder-design.md` before touching code — it is the authoritative design and defines the component boundaries, payload schema, and error-handling matrix.

## Repository layout — two separate Gradle projects

This repo contains **two independent Android Gradle builds**, not one. They do not share a `settings.gradle.kts`.

| Path | Root project | Package | Role |
|------|--------------|---------|------|
| `android/` | `Vitalix` | `com.android.vitalix` | **The real target.** Currently still the default Android Studio Navigation template (`MainActivity` + `FirstFragment`/`SecondFragment`). The Vitalix app is built *here*. |
| `android/healthexport/` | `HealthConnectExporter` | `com.healthexport` | **Reference source only.** The recovered upstream clone (has its own nested `.git`). Read it for reusable UI, models, and worker scaffolding. Do not ship it. |
| `web/` | — | — | Empty placeholder. |
| `docs/branding/` | — | — | Brand guide + SVGs (`vitalix-icon.svg`, `vitalix-lockup.svg`). |

When a build/test command is ambiguous, it almost always means the `android/` (Vitalix) project.

## Build & test

Each project is a standard Gradle-wrapper Android build. Run commands from the project root (`android/` or `android/healthexport/`), using that root's `./gradlew`.

```bash
cd android            # or: cd android/healthexport
./gradlew assembleDebug          # build debug APK
./gradlew installDebug           # build + install to connected device/emulator
./gradlew testDebugUnitTest      # JVM unit tests (no device)
./gradlew connectedAndroidTest   # instrumented tests (needs device/emulator)
./gradlew lint                   # Android lint
```

Run a single unit test class/method:

```bash
./gradlew testDebugUnitTest --tests "com.android.vitalix.SomeTest"
./gradlew testDebugUnitTest --tests "com.android.vitalix.SomeTest.someMethod"
```

Toolchain differences between the two projects — do not cross-copy settings:
- **`android/` (Vitalix):** Gradle 9.5, AGP via `gradle/libs.versions.toml` version catalog, `compileSdk 36` / `minSdk 30` / Java 11. Dependencies use `libs.*` aliases.
- **`android/healthexport/`:** `compileSdk 34` / `minSdk 28` / Java 17. Dependencies are hardcoded literals in `app/build.gradle.kts` (no version catalog).

## Implementation status & plan

Implementation of the forwarder has **not started** — `android/` is still the template, and the design doc is a draft. The build-out (per the spec) is:

1. **`HealthConnectManager.kt` — must be written from scratch.** The upstream repo referenced it 12× but never committed it; it is the actual data-reading engine (declares HC permissions for all record types, per-day aggregation, `saferExportMode` chunking to avoid HC rate limits). The recovered `healthexport` source is missing this class.
2. **`ServerForwarder.kt`** — replaces `SheetsManager`; builds the JSON payload and `POST`s it (OkHttp), adds `Authorization: Bearer` iff a token is set.
3. **`SyncSettings.kt`** — single source of truth for config. `EncryptedSharedPreferences` for `serverUrl` + `authToken`; plain prefs for metric flags/schedule/`lastSync`.
4. **`ExportWorker.kt`** (adapt) — swap `SheetsManager` → `ServerForwarder`, keep WorkManager retry + foreground notification semantics.
5. **`MainActivity.kt`** (adapt) — server-URL/token fields replace the Google-account/spreadsheet UI; keep metric checkboxes, date-range, HC permission flow; add "Sync now" + auto-sync toggle.

**Dropped from the reference:** `SheetsManager`, `CsvExporter`, `CsvGuidanceActivity`, `ManualExportReminderWorker`, and all Google Sheets / Play Services auth / GSON dependencies.

## Component boundaries (keep these strict)

- **`HealthConnectManager`** knows only Health Connect. In: `ExportConfig`. Out: `List<DailyHealthData>`. No network, no settings.
- **`ServerForwarder`** knows only JSON + HTTP. No Health Connect knowledge.
- **`SyncSettings`** is the only thing that touches `SharedPreferences`. `MainActivity` and `ExportWorker` read/write config *through it*, never directly.

This keeps the JSON builder and the settings↔`ExportConfig` mapping pure and unit-testable without a device. The webhook payload schema is fully specified in the design doc — match it exactly (only user-enabled metrics appear; omitted, not null; aggregates use `MinMaxAvg`).

## Data models

`models/HealthData.kt` (in the reference project) is reused as-is: `DailyHealthData`, `ExerciseData`, `BodyMeasurementData`, `ExportConfig` (the ~30 `include*` metric flags + `daysBack`), and `MinMaxAvg`.

## Data Completeness

Read `./docs/health-connect-data-coverage.md` to get the comparison of the data that it scraped versus the availability

## Branding

App name **Vitalix**. Primary Vital Teal `#0FA9A0`, accent Pulse Green `#34D399` (gradient 135°). Voice is direct/technical — sync states are *Idle · Exporting · Sent · Failed (retry)*; no emoji or wellness fluff in system messages. Full guide: `docs/branding/vitalix-branding.md`.
