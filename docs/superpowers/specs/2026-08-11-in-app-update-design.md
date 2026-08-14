# In-App Update Screen (Mihon-Style)

**Date:** 2026-08-11
**Status:** Draft

## Overview

Replace the current `AlertDialog` update prompt with a full-screen `UpdateActivity` that mirrors Mihon's update experience: changelog display, APK download with progress bar, and in-place install trigger.

## Components

### 1. `UpdateInfo` data class (new)

```kotlin
data class UpdateInfo(
    val versionName: String,   // e.g. "1.2.0"
    val versionCode: Int,      // for version comparison
    val changelog: String,     // raw text from Zealot API
    val downloadUrl: String,   // APK download URL
)
```

Parcelable so it can pass through Intent extras.

### 2. `UpdateActivity` (new)

Full-screen Activity with dark Vitalix-themed background. Layout (top to bottom):

- **Icon:** Warning/update badge icon (teal, matching brand)
- **Heading:** "New version available!" — large, bold
- **Version badge:** "v1.2.0" — subtitle text
- **Changelog area:** Scrollable, simple formatted text (bold `### ` headers, `- ` bullet points rendered via SpannableString)
- **Bottom-docked buttons** (with navigation bar inset, same pattern as MainActivity's `barSyncNow`):
  - Primary: "Download" / "Cancel" / "Install" / "Retry" (filled MaterialButton, teal)
  - Secondary: "Not now" (outlined MaterialButton)

#### States

| State | Primary Button | Progress | Notes |
|-------|---------------|----------|-------|
| `READY` | "Download" | Hidden | Initial state |
| `DOWNLOADING` | "Cancel" | Linear progress bar + percentage text | Polls DownloadManager every 300ms |
| `DOWNLOADED` | "Install" | Hidden | APK ready |
| `ERROR` | "Retry" | Hidden | Error message shown below changelog |

#### Lifecycle

- Receives `UpdateInfo` via Intent extras
- Saves `downloadId` in `onSaveInstanceState` to survive rotation
- On recreate with active `downloadId`, resumes progress polling
- "Not now" cancels any in-progress download and calls `finish()`
- Back button behaves like "Not now"

### 3. `UpdateManager` modifications

**`checkForUpdate` changes:**
- Callback signature changes from `(downloadUrl: String) -> Unit` to `(UpdateInfo) -> Unit`
- Parse `changelog` field from Zealot API response (in addition to existing `install_url` and `build_version`)
- Parse `version` (display name) from response; fall back to `build_version` if absent

**New `downloadApk` method:**
- Downloads APK to app-internal cache directory (`context.cacheDir`) instead of public Downloads
- Returns `downloadId` for progress tracking
- New `queryProgress(downloadId): DownloadProgress` method returns bytes downloaded / total / status

**New `getApkUri` method:**
- Uses `FileProvider` to generate content URI for the cached APK file
- Matches existing `file_provider_paths.xml` config

**Remove:** `downloadAndInstall` method (replaced by the two-step download + install flow in `UpdateActivity`)

### 4. `MainActivity` modifications

**`checkForAppUpdate()`:** Replace `AlertDialog` with:
```kotlin
manager.checkForUpdate(...) { updateInfo ->
    runOnUiThread {
        startActivity(UpdateActivity.intent(this, updateInfo))
    }
}
```

**`handleUpdateIntent()`:** FCM-triggered updates now also route through `UpdateActivity` instead of directly calling `downloadAndInstall`.

### 5. `VitalixFirebaseService` modifications

FCM `app_update` messages now include `changelog` in the data payload (optional, empty string if absent). The notification tap intent carries all `UpdateInfo` fields so `UpdateActivity` can display the full screen.

## Update Flow

### On app open
1. `MainActivity.onCreate()` → auth check → onboarding check → `UpdateManager.checkForUpdate()` (async, off main thread)
2. If update found → `startActivity(UpdateActivity)` with `UpdateInfo` extras
3. `UpdateActivity` blocks — user must tap "Not now" to reach MainActivity
4. If no update or Zealot not configured → proceed to MainActivity normally

### On FCM push
1. FCM message with `type=app_update` received
2. Notification shown with "Vitalix Update Available"
3. Tap → launches `UpdateActivity` (not MainActivity) with update info extras

### Download + Install
1. User taps "Download" → `UpdateManager.downloadApk()` enqueues via `DownloadManager`
2. Coroutine polls `DownloadManager.Query` every 300ms, updates progress bar
3. Download completes → state flips to `DOWNLOADED`, button becomes "Install"
4. User taps "Install" → `ACTION_VIEW` intent with `FileProvider` content URI → OS package installer takes over
5. OS handles installation; app may be killed during install (normal Android behavior)

## Layout Design

Matches Mihon's visual style adapted to Vitalix branding:
- Background: dark theme color (`colorSurface`)
- Icon: Material `ic_system_update` or custom teal update icon
- Typography: `textAppearanceHeadlineMedium` for heading, `textAppearanceBodySmall` for version, `textAppearanceBodyMedium` for changelog
- Buttons follow existing MaterialButton styling in the app
- Bottom bar uses same edge-to-edge inset handling as MainActivity

## Changelog Rendering

Simple SpannableString-based rendering, no Markdown library:
- Lines starting with `### ` → bold, slightly larger
- Lines starting with `- ` or `* ` → bullet point with left margin
- Empty lines → spacing
- Everything else → normal body text

## Edge Cases

| Case | Behavior |
|------|----------|
| No network during check | Silent fail, user proceeds to MainActivity |
| Download fails | ERROR state with "Retry" button |
| User taps "Not now" during download | Cancel download via `DownloadManager.remove()`, finish Activity |
| Screen rotation during download | `downloadId` saved/restored, progress polling resumes |
| Zealot endpoint not configured | Skip check entirely (existing behavior) |
| Changelog empty or absent | Show version number only, hide changelog section |
| `REQUEST_INSTALL_PACKAGES` denied | OS prompts when install intent fires (manifest permission already declared) |

## Files Changed

| File | Change |
|------|--------|
| `UpdateActivity.kt` | New |
| `activity_update.xml` | New |
| `UpdateManager.kt` | Modify — add `UpdateInfo`, richer API, progress tracking |
| `MainActivity.kt` | Modify — replace AlertDialog with UpdateActivity launch |
| `VitalixFirebaseService.kt` | Modify — route tap to UpdateActivity |
| `AndroidManifest.xml` | Add UpdateActivity declaration |
| `file_provider_paths.xml` | Add `<cache-path>` entry for APK storage |
| `strings.xml` | Add update-related strings |

## Not in Scope

- Automatic background update checks (only on app open + FCM)
- Delta/patch updates (full APK only)
- Version skipping / "don't remind me for this version"
- Play Store in-app updates API (not applicable — sideloaded via Zealot)
