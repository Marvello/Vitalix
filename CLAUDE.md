# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Vitalix is an Android app that reads Health Connect data on-device and **forwards it as JSON to a user-controlled server** (webhook + optional bearer token). Privacy-first, self-hosted — no Google Sheets, no CSV, no third-party data path.

It is a re-target of the upstream `teqxnology/healthexport` app, swapping the Google Sheets/CSV export destination for a generic HTTP `POST`.

Read `docs/superpowers/specs/2026-07-21-vitalix-health-forwarder-design.md` before touching code — it is the authoritative design and defines the component boundaries, payload schema, and error-handling matrix.

## Repository layout

| Path | Role |
|------|------|
| `android/` | The Vitalix Android app (Gradle root `Vitalix`, package `com.android.vitalix`). |
| `web/` | Self-hosted receiver: Node/Express + Postgres, dashboard, AI recommendations. See `web/README.md`. |
| `docs/branding/` | Brand guide + SVGs (`vitalix-icon.svg`, `vitalix-lockup.svg`). |

Build/test commands differ per directory; run them from `android/` or `web/` as the change requires.

## Build & test

Android: a standard Gradle-wrapper build; run from `android/`. Web: `cd web && npm test` (node --test); `web/test/persist.db.test.js` needs a throwaway Postgres via `TEST_DATABASE_URL` (see `web/README.md`).

The app has product flavors, so variant tasks are flavored (e.g. `testProductionDebugUnitTest`, `assembleProductionDebug`); the unflavored names below are shorthand.

```bash
cd android
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

Toolchain: Gradle 9.5, AGP via `android/gradle/libs.versions.toml` version catalog, `compileSdk 37` / `minSdk 30` / Java 11. Dependencies use `libs.*` aliases.

## Component boundaries (keep these strict)

- **`HealthConnectManager`** knows only Health Connect. In: `ExportConfig`. Out: `List<DailyHealthData>`. No network, no settings.
- **`ServerForwarder`** knows only JSON + HTTP. No Health Connect knowledge.
- **`SyncSettings`** is the only thing that touches `SharedPreferences`. `MainActivity` and `ExportWorker` read/write config *through it*, never directly.

Sync windows always start at **local midnight** (`HealthConnectManager.windowStart`): the server stores per-day totals, so a mid-day start overwrites a day with a partial total. `lastSync` only advances on a clean, non-empty read. The receiver's in-memory rate limits assume a **single replica**.

This keeps the JSON builder and the settings↔`ExportConfig` mapping pure and unit-testable without a device. The webhook payload schema is fully specified in the design doc — match it exactly (only user-enabled metrics appear; omitted, not null; aggregates use `MinMaxAvg`).

## Data models

`android/app/src/main/java/com/android/vitalix/models/HealthData.kt`: `DailyHealthData`, `ExerciseData`, `BodyMeasurementData`, `ExportConfig` (the `include*` metric flags + `daysBack`), and `MinMaxAvg`.

## Data Completeness

Read `./docs/health-connect-data-coverage.md` to get the comparison of the data that it scraped versus the availability

## Branding

App name **Vitalix**. Primary Vital Teal `#0FA9A0`, accent Pulse Green `#34D399` (gradient 135°). Voice is direct/technical — sync states are *Idle · Exporting · Sent · Failed (retry)*; no emoji or wellness fluff in system messages. Full guide: `docs/branding/vitalix-branding.md`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
