# BMI Feature — Design

**Date:** 2026-08-03
**Status:** Approved
**Scope:** Android (user profile, onboarding, manual weight input, HC write) + Web (BMI computation, card, chart)

---

## Summary

Add BMI tracking to Vitalix. The Android app collects user profile data (name, height, weight) via a first-launch onboarding screen and settings, supports manual weight input that writes back to Health Connect, and sends profile height in the sync payload. The web dashboard computes BMI server-side from existing weight + height data, forward-fills gaps using SQL window functions, and displays a BMI card (number, WHO category, colored gauge, trend arrow) with a historical line chart.

### Decisions locked during brainstorming

| Question | Decision |
|----------|----------|
| BMI display location | Web dashboard only (not Android) |
| BMI computation | Server-side from weight + height in `health_days` |
| Chart range | Same as existing top date filter |
| Profile setup | First-launch onboarding + editable in Settings |
| Height source | Health Connect + profile fallback |
| Manual weight input | Simple AlertDialog with weight + date picker |
| BMI card style | Number + WHO category + colored gauge + trend arrow |
| Forward-fill strategy | PostgreSQL `LAST_VALUE` window function |
| BMI scale | Auto from device locale (Standard vs Asian WHO), user override in settings |

---

## Architecture

### Android changes

#### 1. User profile in `SyncSettings`

New fields in plain prefs:

- `userName: String?`
- `userHeightCm: Double?`
- `userWeightKg: Double?`
- `onboardingComplete: Boolean`
- `bmiScale: String?` — `"standard"` or `"asian"`. `null` = auto-detect from device locale.

`SyncSettings` is the single source of truth — no direct `SharedPreferences` access elsewhere.

**BMI scale auto-detection:** On first launch (or when `bmiScale` is null), derive from `Locale.getDefault().country`. Asian WHO cutoffs apply for country codes: `CN`, `JP`, `KR`, `IN`, `TW`, `HK`, `SG`, `MY`, `TH`, `PH`, `ID`, `VN`, `BD`, `LK`, `PK`, `MM`, `KH`, `LA`, `NP`, `BN`. All others default to standard WHO. User can override in Settings.

#### 2. `OnboardingActivity`

Shown on first launch when `onboardingComplete == false`. Three input fields:

- **Name** — text input
- **Height** — numeric input (cm)
- **Weight** — numeric input (kg)

On completion:
1. Save all three to `SyncSettings`
2. Write `HeightRecord` to Health Connect (height in meters)
3. Write `WeightRecord` to Health Connect (weight in kg, dated today)
4. Set `onboardingComplete = true`
5. Navigate to `MainActivity`

#### 3. `SettingsActivity` profile section

New "Profile" section with Name, Height, Weight fields. Edits to height/weight also write the corresponding record to Health Connect.

#### 4. Health Connect write permissions

Add to `HealthConnectManager`:
- `WRITE` permission for `WeightRecord` and `HeightRecord`
- `suspend fun insertWeightRecord(kg: Double, date: LocalDate)`
- `suspend fun insertHeightRecord(cm: Double, date: LocalDate)`

These are requested alongside existing read permissions. If write permission is denied, manual weight input is disabled but the rest of the app works normally.

#### 5. Manual weight input dialog

`AlertDialog` with:
- Weight field (kg, numeric, one decimal)
- Date picker (defaults to today)

Triggered from Settings (or future placement). On submit:
1. Write `WeightRecord` to Health Connect
2. Update `SyncSettings.userWeightKg`
3. Toast confirmation
4. If auto-sync is on, trigger sync

#### 6. Payload change

Add `profileHeightM` to the top-level payload metadata:

```json
{
  "source": "vitalix",
  "appVersion": "1.0.0",
  "profileHeightM": 1.78,
  "bmiScale": "asian",
  "days": [...]
}
```

- `profileHeightM` = `SyncSettings.userHeightCm / 100`. Nullable — omitted if no height set.
- `bmiScale` = `"standard"` or `"asian"`. Resolved value (never null in payload — auto-detect applied before sending).

---

### Web changes

#### 1. Database migration

Add columns to `users` table:

```sql
ALTER TABLE users ADD COLUMN profile_height_m double precision;
ALTER TABLE users ADD COLUMN bmi_scale text DEFAULT 'standard';
```

`bmi_scale` is `"standard"` or `"asian"` — updated on each sync from the payload.

#### 2. Payload ingestion

In `mapPayload.js` / `persist.js`: extract `profileHeightM` and `bmiScale` from payload and update `users.profile_height_m` and `users.bmi_scale` for the authenticated user on each sync.

#### 3. BMI computation — `stats.bmiSeries(userId, from, to)`

New function in `stats.js`. SQL query:

```sql
WITH date_series AS (
  SELECT generate_series($2::date, $3::date, '1 day')::date AS day
),
raw AS (
  SELECT ds.day, hd.weight, hd.height
  FROM date_series ds
  LEFT JOIN health_days hd ON hd.day = ds.day AND hd.user_id = $1
),
filled AS (
  SELECT
    day,
    LAST_VALUE(weight) FILTER (WHERE weight IS NOT NULL)
      OVER (ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS weight,
    COALESCE(
      LAST_VALUE(height) FILTER (WHERE height IS NOT NULL)
        OVER (ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
      (SELECT profile_height_m FROM users WHERE id = $1)
    ) AS height
  FROM raw
)
SELECT day, weight, height,
       CASE WHEN height > 0 THEN ROUND((weight / (height * height))::numeric, 1) END AS bmi
FROM filled
WHERE weight IS NOT NULL
ORDER BY day
```

Key behaviors:
- Weight forward-filled: last known value carries forward across gap days
- Height: HC value preferred, falls back to `users.profile_height_m`
- Days before first-ever weight measurement are excluded (no backwards fill)
- BMI = `weight(kg) / height(m)²`, rounded to 1 decimal

#### 4. `chartData.js` — `fillForward(rows, from, to, column)`

Like existing `fillDays` but nulls become the last non-null value. Used for the BMI chart series.

```js
export function fillForward(rows, from, to, column) {
  const byDay = new Map(rows.map((r) => [toKey(r.day), r]));
  let last = null;
  return dateRange(from, to).map((date) => {
    const row = byDay.get(date);
    const value = row ? row[column] : null;
    if (value != null) last = Number(value);
    return { date, value: last };
  });
}
```

#### 5. `CARD_CATALOG` entry

```js
{ key: "bmi", label: "BMI", category: "Body", type: "bmi" }
```

New card type `"bmi"` — distinct from `"line"` because it renders a composite card.

#### 6. BMI card rendering (in `dashboard.ejs`)

The card has two parts:

**Tile (top):**
- Current BMI value (latest non-null in range) — large number
- WHO category label, based on user's BMI scale setting:

  **Standard WHO:** Underweight (< 18.5), Normal (≥ 18.5, < 25), Overweight (≥ 25, < 30), Obese (≥ 30)

  **Asian WHO:** Underweight (< 18.5), Normal (≥ 18.5, < 23), Overweight (≥ 23, < 27.5), Obese (≥ 27.5)
- Horizontal gauge bar — four colored segments (blue/green/yellow/red), marker dot at current BMI
- Trend arrow — compare latest BMI to BMI at start of previous equivalent period. Show ↑/↓/→ with delta (e.g. "↓ 0.3")

**Chart (below):**
- Line chart of daily BMI over the date range
- Same rendering approach as existing line-type cards
- Uses forward-filled data so the line is continuous

**Empty states:**
- No weight data: "No weight data"
- Weight but no height: "Set your height in the app to see BMI"

#### 7. Gauge design

Pure CSS + inline styles (no external library). Horizontal bar, ~200px wide:

| Range | Color | Label |
|-------|-------|-------|
**Standard WHO scale:**

| Range | Color | Label |
|-------|-------|-------|
| < 18.5 | `#60A5FA` (blue) | Underweight |
| ≥ 18.5, < 25 | `#34D399` (green, brand accent) | Normal |
| ≥ 25, < 30 | `#FBBF24` (yellow) | Overweight |
| ≥ 30 | `#F87171` (red) | Obese |

**Asian WHO scale:**

| Range | Color | Label |
|-------|-------|-------|
| < 18.5 | `#60A5FA` (blue) | Underweight |
| ≥ 18.5, < 23 | `#34D399` (green, brand accent) | Normal |
| ≥ 23, < 27.5 | `#FBBF24` (yellow) | Overweight |
| ≥ 27.5 | `#F87171` (red) | Obese |

Marker: small circle positioned proportionally on the bar (clamped to 15–40 range for display).

---

## Error handling

| Scenario | Handling |
|----------|----------|
| No weight data | BMI card: "No weight data" — no gauge, no chart |
| Weight exists, no height (HC or profile) | BMI card: "Set your height in the app to see BMI" |
| Height only from profile | Use profile height for all BMI calculations |
| HC write fails (manual weight) | Toast error, keep dialog open for retry |
| HC write permission denied | Rationale dialog; manual input disabled; rest of app works |
| Forward-fill before first weight | No fill — chart starts from first recorded date |
| `profileHeightM` missing from payload | No-op — server keeps existing `profile_height_m` value |

---

## Component boundaries

- **`HealthConnectManager`** — gains write capability for `WeightRecord` / `HeightRecord`. Still knows nothing about network or settings.
- **`SyncSettings`** — gains profile fields. Still the only thing touching prefs.
- **`OnboardingActivity`** — reads/writes through `SyncSettings`, calls `HealthConnectManager` for HC writes. No direct pref access.
- **`stats.bmiSeries()`** — pure DB query, returns `[{day, weight, height, bmi}]`. No rendering knowledge.
- **`chartData.fillForward()`** — pure function, no DB or DOM.
- **BMI card template** — renders from pre-shaped data. No SQL.

---

## Testing

**Android:**
- Unit test: BMI formula correctness (edge cases: very low/high weight, zero height guard)
- Unit test: `SyncSettings` profile field read/write roundtrip
- Integration test: `insertWeightRecord` / `insertHeightRecord` write to HC and are readable

**Web:**
- Unit test: `fillForward` — gaps filled, no backwards fill, all-null returns all-null
- Unit test: BMI computation from weight + height (matches WHO formula)
- Unit test: WHO category boundaries (18.5, 25, 30 exact values)
- Unit test: trend calculation (positive, negative, zero delta)
- Integration test: `bmiSeries` query with forward-fill and profile height fallback
- Visual: BMI card renders gauge, trend, chart correctly; empty states display properly
