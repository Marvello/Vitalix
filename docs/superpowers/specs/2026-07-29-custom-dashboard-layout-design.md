# Custom Dashboard Layout

**Date:** 2026-07-29
**Status:** Draft

## Goal

Let users choose which chart cards appear on their dashboard and in what order. Persist the layout per-user so it survives logout/login.

## Scope

**In scope:**
- Show/hide any chart card (17 DAY_METRICS, 4 BAND_METRICS, sleep, HR split, workouts, recent days)
- Reorder cards via up/down buttons
- Add card via picker (shows metrics not yet on dashboard)
- Remove card via X button on each card
- Reset to default (show all cards with data)
- Persist layout per user in DB

**Out of scope:**
- Composite/multi-metric charts
- Custom chart type or styling per metric
- Summary tile customization (tiles stay auto-generated)
- Drag-and-drop reorder (up/down buttons are sufficient)

## Data Model

New table `dashboard_layouts`:

```sql
CREATE TABLE dashboard_layouts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cards   JSONB NOT NULL DEFAULT '[]'
);
```

`cards` is an ordered JSON array of string keys.

### Card Key Catalog

| Key | Chart type | Source |
|-----|-----------|--------|
| `steps` | bar | DAY_METRICS |
| `distance` | line | DAY_METRICS |
| `total_calories` | line | DAY_METRICS |
| `active_calories` | line | DAY_METRICS |
| `floors_climbed` | bar | DAY_METRICS |
| `elevation_gained` | line | DAY_METRICS |
| `wheelchair_pushes` | bar | DAY_METRICS |
| `resting_heart_rate` | line | DAY_METRICS |
| `vo2_max` | line | DAY_METRICS |
| `weight` | line | DAY_METRICS |
| `body_fat` | line | DAY_METRICS |
| `lean_body_mass` | line | DAY_METRICS |
| `bone_mass` | line | DAY_METRICS |
| `height` | line | DAY_METRICS |
| `body_temperature` | line | DAY_METRICS |
| `hydration_ml` | bar | DAY_METRICS |
| `energy_kcal` | bar | DAY_METRICS |
| `band:heartRate` | band | BAND_METRICS |
| `band:spo2` | band | BAND_METRICS |
| `band:hrv` | band | BAND_METRICS |
| `band:respiratoryRate` | band | BAND_METRICS |
| `sleep` | stacked bar | special |
| `hr_split` | dual band | special |
| `workouts` | table | special |
| `recent` | table | special |

Example stored value: `["steps", "band:heartRate", "sleep", "weight", "workouts"]`

### Default behavior

If no `dashboard_layouts` row exists for user, use current behavior: show all cards that have data, in the hardcoded order. First time user customizes, the row is created.

## API

All endpoints require `requireAuth`. Full-page reload after each mutation.

| Method | Path | Body | Action |
|--------|------|------|--------|
| `PUT` | `/dashboard/layout` | `{ cards: string[] }` | Save full card list + order |
| `DELETE` | `/dashboard/layout` | — | Reset to default (delete row) |
| `POST` | `/dashboard/layout/add` | `{ card: string }` | Append one card to layout |

### Validation

- `PUT`: reject if any key is not in the card catalog. Deduplicate. Max 25 cards.
- `POST /add`: reject if key not in catalog or already in user's layout.
- All: validate user owns the layout (enforced by `requireAuth` + `user_id` from session).

## Server Logic (pages.js)

### GET /dashboard changes

1. Query `dashboard_layouts` for `req.user.id`
2. If row exists (`layoutMode = "custom"`):
   - Filter `cards` to only those with data in the current range (same visibility logic as today)
   - Render cards in the stored order
   - Compute `availableCards` = catalog cards that have data but aren't in the layout
3. If no row (`layoutMode = "default"`):
   - Current behavior: show all cards with data in hardcoded order
   - `availableCards` = empty (everything already shown)
4. Pass `layoutMode`, `cards`, `availableCards` to template

### Card rendering refactor

Currently dashboard.ejs renders each chart type inline in a fixed sequence. Refactor to a data-driven card loop:

- Server builds a `cards` array of objects: `{ key, label, type, data }` where `type` is one of `bar`, `line`, `band`, `stacked`, `split_band`, `table`
- Template loops over `cards`, rendering card chrome (header, move/remove buttons) around each
- Client-side `drawAll()` dispatches by card key to the appropriate chart function

### What stays unchanged

- All chart rendering functions (barChart, lineChart, bandChart, stackedChart, splitBandChart)
- All stats queries (stats.js)
- Source filtering
- Summary tiles
- Date range picker

## UI

### Card chrome

Each card gets a header row with the chart title and action buttons:

```
┌─────────────────────────────────────────────┐
│ Steps                        [↑] [↓] [×]   │
│ ▐▐ ▐▐▐ ▐▐▐▐ ▐▐ ▐▐▐ ▐▐▐▐▐ ▐▐              │
│                                             │
└─────────────────────────────────────────────┘
```

- `↑` / `↓`: swap with adjacent card, `PUT /dashboard/layout` with new order
- `×`: remove card from layout, `PUT /dashboard/layout` with card removed
- Buttons only visible in custom layout mode (hidden in default mode until first customization)

### Add chart button

Below all cards, a button: **"+ Add Chart"**

Clicking opens a picker (inline expandable section, not a modal) showing available metrics grouped by category:

- **Activity:** steps, distance, calories, floors, elevation, wheelchair pushes
- **Heart & Lungs:** resting HR, heart rate (band), SpO2 (band), HRV (band), respiratory rate (band), VO2 max
- **Body:** weight, body fat, lean body mass, bone mass, height, body temperature
- **Nutrition:** hydration, energy
- **Sleep & Recovery:** sleep
- **Workouts:** workouts, HR split
- **Overview:** recent days

Each item shows the metric name. Grayed out if no data exists for it. Click → `POST /dashboard/layout/add` → reload.

### Reset link

When in custom mode, show a "Reset to default" link near the "Add Chart" button. `DELETE /dashboard/layout` → reload.

## Migration

```
migrations/1722200000000_dashboard_layouts.cjs
```

Standard node-pg-migrate up/down.

## Files Changed

| File | Change |
|------|--------|
| `migrations/1722200000000_dashboard_layouts.cjs` | New: create table |
| `src/routes/pages.js` | Add layout endpoints; refactor GET /dashboard to use layout |
| `views/dashboard.ejs` | Card loop, add/remove/reorder buttons, add-chart picker |
| `src/stats.js` | Export card catalog constant (CARD_CATALOG) |

## Testing

- No layout row → default behavior (all cards with data, hardcoded order)
- Add a card → row created, card appears
- Reorder → order persists after reload
- Remove → card gone after reload
- Reset → row deleted, back to default
- Invalid card key rejected by PUT/POST
- Layout survives logout/login
