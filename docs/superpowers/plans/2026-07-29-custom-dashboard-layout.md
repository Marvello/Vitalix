# Custom Dashboard Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users choose which chart cards appear on their dashboard and in what order, persisted in the DB.

**Architecture:** New `dashboard_layouts` table stores a JSONB array of card keys per user. The dashboard route reads this to determine which cards render and in what order. Three new endpoints handle add/remove/reorder via full-page reloads. A card catalog constant maps keys to their chart type, label, and category.

**Tech Stack:** Node.js, Express, PostgreSQL (JSONB), EJS templates, node-pg-migrate

## Global Constraints

- Card keys must match the catalog exactly — no arbitrary strings
- Max 25 cards per layout
- No client-side JS frameworks — server-rendered EJS with full-page reloads
- All layout endpoints require `requireAuth`
- Default mode (no DB row) = current behavior unchanged

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `migrations/1722200000000_dashboard_layouts.cjs` | Create | DB migration |
| `src/stats.js` | Modify | Add `CARD_CATALOG`, `getLayout`, `saveLayout`, `deleteLayout` |
| `src/routes/pages.js` | Modify | Add layout endpoints, refactor GET /dashboard card assembly |
| `views/dashboard.ejs` | Modify | Card loop, action buttons, add-chart picker |

---

### Task 1: Migration + layout DB functions

**Files:**
- Create: `migrations/1722200000000_dashboard_layouts.cjs`
- Modify: `src/stats.js` (append layout functions at end of file)

**Produces:**
- `getLayout(userId): Promise<string[] | null>` — returns cards array or null if no row
- `saveLayout(userId, cards): Promise<void>` — upsert cards array
- `deleteLayout(userId): Promise<void>` — delete row (reset to default)
- `CARD_CATALOG`: array of `{ key, label, category, type }` objects

- [ ] **Step 1: Create migration file**

Create `web/migrations/1722200000000_dashboard_layouts.cjs`:

```js
exports.up = (pgm) => {
  pgm.createTable("dashboard_layouts", {
    user_id: {
      type: "integer",
      primaryKey: true,
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    cards: { type: "jsonb", notNull: true, default: "'[]'" },
  });
};

exports.down = (pgm) => {
  pgm.dropTable("dashboard_layouts");
};
```

- [ ] **Step 2: Run migration**

```bash
cd web && DATABASE_URL=postgres://vitalix:vitalix@localhost:5432/vitalix npx node-pg-migrate up
```

Expected: `1722200000000_dashboard_layouts` applied.

- [ ] **Step 3: Add CARD_CATALOG and layout functions to stats.js**

Append to `web/src/stats.js`:

```js
export const CARD_CATALOG = [
  // Activity
  { key: "steps",             label: "Steps",              category: "Activity",        type: "bar"  },
  { key: "distance",          label: "Distance",           category: "Activity",        type: "line" },
  { key: "total_calories",    label: "Total calories",     category: "Activity",        type: "line" },
  { key: "active_calories",   label: "Active calories",    category: "Activity",        type: "line" },
  { key: "floors_climbed",    label: "Floors climbed",     category: "Activity",        type: "bar"  },
  { key: "elevation_gained",  label: "Elevation gained",   category: "Activity",        type: "line" },
  { key: "wheelchair_pushes", label: "Wheelchair pushes",  category: "Activity",        type: "bar"  },
  // Heart & Lungs
  { key: "resting_heart_rate",    label: "Resting heart rate",  category: "Heart & Lungs", type: "line" },
  { key: "band:heartRate",        label: "Heart rate",          category: "Heart & Lungs", type: "band" },
  { key: "band:spo2",             label: "SpO2",                category: "Heart & Lungs", type: "band" },
  { key: "band:hrv",              label: "HRV",                 category: "Heart & Lungs", type: "band" },
  { key: "band:respiratoryRate",  label: "Respiratory rate",    category: "Heart & Lungs", type: "band" },
  { key: "vo2_max",               label: "VO2 max",             category: "Heart & Lungs", type: "line" },
  // Body
  { key: "weight",           label: "Weight",          category: "Body", type: "line" },
  { key: "body_fat",         label: "Body fat",        category: "Body", type: "line" },
  { key: "lean_body_mass",   label: "Lean body mass",  category: "Body", type: "line" },
  { key: "bone_mass",        label: "Bone mass",       category: "Body", type: "line" },
  { key: "height",           label: "Height",          category: "Body", type: "line" },
  { key: "body_temperature", label: "Body temperature",category: "Body", type: "line" },
  // Nutrition
  { key: "hydration_ml",  label: "Hydration",  category: "Nutrition", type: "bar"  },
  { key: "energy_kcal",   label: "Energy",     category: "Nutrition", type: "bar"  },
  // Sleep & Recovery
  { key: "sleep",  label: "Sleep",  category: "Sleep & Recovery", type: "stacked" },
  // Workouts
  { key: "workouts",  label: "Workouts",                    category: "Workouts", type: "table" },
  { key: "hr_split",  label: "Heart rate — workout vs rest", category: "Workouts", type: "split_band" },
  // Overview
  { key: "recent",  label: "Recent days",  category: "Overview", type: "table" },
];

const VALID_KEYS = new Set(CARD_CATALOG.map((c) => c.key));

export function isValidCardKey(key) {
  return VALID_KEYS.has(key);
}

export async function getLayout(userId) {
  const { rows } = await query(
    "SELECT cards FROM dashboard_layouts WHERE user_id = $1",
    [userId],
  );
  return rows.length ? rows[0].cards : null;
}

export async function saveLayout(userId, cards) {
  await query(
    `INSERT INTO dashboard_layouts (user_id, cards)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET cards = $2`,
    [userId, JSON.stringify(cards)],
  );
}

export async function deleteLayout(userId) {
  await query("DELETE FROM dashboard_layouts WHERE user_id = $1", [userId]);
}
```

- [ ] **Step 4: Verify migration and functions compile**

```bash
cd web && node -e "import('./src/stats.js').then(m => { console.log('catalog:', m.CARD_CATALOG.length, 'entries'); console.log('valid steps:', m.isValidCardKey('steps')); console.log('invalid foo:', m.isValidCardKey('foo')); })"
```

Expected: `catalog: 25 entries`, `valid steps: true`, `invalid foo: false`

- [ ] **Step 5: Commit**

```bash
git add migrations/1722200000000_dashboard_layouts.cjs src/stats.js
git commit -m "feat: add dashboard_layouts table and card catalog"
```

---

### Task 2: Layout API endpoints

**Files:**
- Modify: `src/routes/pages.js` — add three new routes after existing routes

**Consumes:**
- `stats.getLayout(userId)`, `stats.saveLayout(userId, cards)`, `stats.deleteLayout(userId)`, `stats.isValidCardKey(key)`, `stats.CARD_CATALOG` from Task 1

**Produces:**
- `PUT /dashboard/layout` — saves card order
- `POST /dashboard/layout/add` — appends one card
- `DELETE /dashboard/layout` — resets to default

- [ ] **Step 1: Add imports to pages.js**

At the top of `src/routes/pages.js`, add to the stats import:

```js
import * as stats from "../stats.js";
```

This import already exists. No change needed here — stats already imported as namespace.

- [ ] **Step 2: Add the three layout endpoints**

Add after the existing routes in `src/routes/pages.js` (before the module's closing), near the bottom of the file:

```js
// --- Dashboard layout management ---

pagesRouter.put("/dashboard/layout", requireAuth, async (req, res) => {
  try {
    let { cards } = req.body;
    if (!Array.isArray(cards)) return res.status(400).json({ error: "cards must be an array" });
    cards = [...new Set(cards)].filter(stats.isValidCardKey);
    if (cards.length > 25) cards = cards.slice(0, 25);
    await stats.saveLayout(req.user.id, cards);
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /dashboard/layout failed", err);
    res.status(500).json({ error: "save failed" });
  }
});

pagesRouter.post("/dashboard/layout/add", requireAuth, async (req, res) => {
  try {
    const { card } = req.body;
    if (!card || !stats.isValidCardKey(card)) {
      return res.status(400).json({ error: "invalid card key" });
    }
    const existing = await stats.getLayout(req.user.id);
    const cards = existing || stats.CARD_CATALOG.map((c) => c.key);
    if (!cards.includes(card)) cards.push(card);
    await stats.saveLayout(req.user.id, cards);
    res.redirect(`/dashboard?range=${req.query.range || 30}`);
  } catch (err) {
    console.error("POST /dashboard/layout/add failed", err);
    res.status(500).json({ error: "add failed" });
  }
});

pagesRouter.delete("/dashboard/layout", requireAuth, async (req, res) => {
  try {
    await stats.deleteLayout(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /dashboard/layout failed", err);
    res.status(500).json({ error: "reset failed" });
  }
});
```

Note on `POST /add`: when first customizing from default mode (no existing row), we snapshot all catalog keys as the starting layout, then append the new card. This preserves "everything visible" as the baseline.

- [ ] **Step 3: Add express.json() middleware if not already present**

Check `src/index.js` — `express.json()` is likely already there for the API routes. If the PUT and DELETE endpoints need JSON body parsing, verify it's mounted. The POST /add uses `req.body.card` so it also needs it.

```bash
grep -n "express.json\|urlencoded" src/index.js
```

If missing, add `app.use(express.json())` before the routes are mounted.

- [ ] **Step 4: Commit**

```bash
git add src/routes/pages.js
git commit -m "feat: add layout CRUD endpoints (PUT/POST/DELETE)"
```

---

### Task 3: Refactor GET /dashboard to use layout

**Files:**
- Modify: `src/routes/pages.js:85-192` — the GET /dashboard handler

**Consumes:**
- `stats.getLayout(userId)`, `stats.CARD_CATALOG`, `stats.isValidCardKey(key)` from Task 1

**Produces:**
- Template receives new variables: `layoutMode`, `cardList` (ordered card descriptor array), `availableCards` (for the picker)

- [ ] **Step 1: Add layout query to the parallel fetch**

In `src/routes/pages.js`, inside GET /dashboard, add `stats.getLayout(req.user.id)` to the existing `Promise.all` at line 93:

```js
const [rows, aggs, totals, metrics, cover, workouts, hrRows, recent, user, savedLayout] = await Promise.all([
  stats.dailyRows(req.user.id, fromKey, toKeyStr),
  stats.aggregateRows(req.user.id, fromKey, toKeyStr),
  stats.summary(req.user.id, fromKey, toKeyStr),
  stats.availableMetrics(req.user.id, fromKey, toKeyStr),
  stats.coverage(req.user.id, fromKey, toKeyStr),
  stats.exerciseBreakdown(req.user.id, fromKey, toKeyStr),
  stats.heartRateSplit(req.user.id, fromKey, toKeyStr),
  stats.recentDays(req.user.id, 14),
  store.findUserById(req.user.id),
  stats.getLayout(req.user.id),
]);
```

- [ ] **Step 2: Build the card list based on layout mode**

After the source filter logic (around line 117), add card-list assembly. This replaces the direct use of `shownDayMetrics` and `bandKeys` for ordering — they're still computed but now the card list controls what renders and in what order.

```js
const layoutMode = savedLayout ? "custom" : "default";

// Determine which special cards have data
const hasSleep = !filterActive && rows.some((r) => r.sleep_duration_minutes != null);
const hasHrSplit = !filterActive && hrRows.some((r) => r.scope === "active");
const hasWorkouts = !filterActive && workouts.length > 0;

// Map of card key → whether it has data in this range
const shownDayMetrics = visibleMetrics(stats.DAY_METRICS, cover);
const bandKeys = stats.BAND_METRICS.filter((m) => metrics.includes(m));
const dayKeysWithData = new Set(shownDayMetrics.map((m) => m.column));
const bandKeysWithData = new Set(bandKeys.map((k) => `band:${k}`));

function cardHasData(key) {
  if (dayKeysWithData.has(key)) return true;
  if (bandKeysWithData.has(key)) return true;
  if (key === "sleep") return hasSleep;
  if (key === "hr_split") return hasHrSplit;
  if (key === "workouts") return hasWorkouts;
  if (key === "recent") return recent.length > 0;
  return false;
}

// Ordered list of card keys to render
let cardKeys;
if (savedLayout) {
  // Custom: use saved order, filter to cards that have data
  cardKeys = savedLayout.filter((k) => stats.isValidCardKey(k) && cardHasData(k));
} else {
  // Default: all DAY_METRICS with data, then sleep, hr_split, bands, workouts, recent
  cardKeys = [
    ...shownDayMetrics.map((m) => m.column),
    ...(hasSleep ? ["sleep"] : []),
    ...(hasHrSplit ? ["hr_split"] : []),
    ...bandKeys.map((k) => `band:${k}`),
    ...(hasWorkouts ? ["workouts"] : []),
    ...((recent.length > 0) ? ["recent"] : []),
  ];
}

// Build card descriptors for the template
const catalogByKey = Object.fromEntries(stats.CARD_CATALOG.map((c) => [c.key, c]));
const cardList = cardKeys.map((key) => ({ key, ...catalogByKey[key] }));

// Available cards for the "add chart" picker (have data but not in layout)
const cardKeySet = new Set(cardKeys);
const availableCards = stats.CARD_CATALOG
  .filter((c) => !cardKeySet.has(c.key) && cardHasData(c.key))
  .map((c) => ({ ...c }));
```

- [ ] **Step 3: Build chart data keyed by card key instead of by index**

Replace the existing `series` and `charts` object construction. The new approach builds a `chartData` map so the template can look up data by card key:

```js
const srcRows = selectedSources.length
  ? await stats.sourceRows(
      req.user.id, fromKey, toKeyStr,
      [...shownDayMetrics.map((m) => m.sourceKey), ...bandKeys],
      selectedSources,
    )
  : [];

const nullPoints = (pts) => pts.map((p) => ({ ...p, value: null }));
const nullBand = (pts) => pts.map((p) => ({ ...p, min: null, max: null, avg: null }));

// Build per-key chart data
const chartData = {};

// DAY_METRICS
for (const m of shownDayMetrics) {
  const points = fillDays(rows, fromKey, toKeyStr, m.column);
  const srcLines = sourceLines(srcRows, fromKey, toKeyStr, m.sourceKey, sourceColors);
  chartData[m.column] = {
    key: m.column,
    label: m.label,
    unit: m.unit ?? null,
    chart: m.chart,
    days: cover[m.column],
    points: filterActive ? nullPoints(points) : points,
    trend: m.trend && !filterActive ? rollingAverage(points, 7) : null,
    sources: srcLines,
    filtered: filterActive,
  };
}

// BAND_METRICS
for (const metric of bandKeys) {
  chartData[`band:${metric}`] = {
    key: `band:${metric}`,
    metric,
    label: metricLabel(metric),
    points: filterActive ? nullBand(bandSeries(aggs, fromKey, toKeyStr, metric))
      : bandSeries(aggs, fromKey, toKeyStr, metric),
    sources: sourceLines(srcRows, fromKey, toKeyStr, metric, sourceColors),
    filtered: filterActive,
  };
}

// Special charts
if (hasSleep) {
  chartData.sleep = { points: sleepStages(rows, fromKey, toKeyStr) };
}
if (hasHrSplit) {
  chartData.hr_split = { points: splitSeries(hrRows, fromKey, toKeyStr) };
}
if (hasWorkouts) {
  chartData.workouts = { rows: workouts };
}
chartData.recent = { rows: recent };
```

- [ ] **Step 4: Update the res.render call**

Replace the existing `res.render("dashboard", { ... })` call with the new variables:

```js
res.render("dashboard", {
  email: user?.email,
  range: days,
  ranges: RANGES,
  tiles: filterActive ? [] : visibleTiles(summaryTiles(totals)),
  totals: filterActive && !selectedSources.length ? {} : totals,
  chartData,
  cardList,
  layoutMode,
  availableCards,
  workouts: filterActive ? [] : workouts,
  recent,
  toKey,
  allActive,
  availableSources: allSources,
  selectedSources,
  sourceColors,
  sourceNames,
  sourceCounts,
  buildInfo,
});
```

Also update the error fallback render call to include the new variables:

```js
res.status(500).render("dashboard", {
  email: null, range: 30, ranges: RANGES, tiles: [], totals: {},
  chartData: {}, cardList: [], layoutMode: "default", availableCards: [],
  workouts: [], recent: [], toKey,
  allActive: true, availableSources: [], selectedSources: [], sourceColors: {}, sourceNames: {}, sourceCounts: {},
  buildInfo,
});
```

Remove the old `charts: EMPTY_CHARTS` — replace with `chartData: {}`.

- [ ] **Step 5: Remove the old EMPTY_CHARTS constant if it exists**

Search for `EMPTY_CHARTS` in pages.js and remove its definition if present.

- [ ] **Step 6: Commit**

```bash
git add src/routes/pages.js
git commit -m "feat: refactor dashboard route to use card layout"
```

---

### Task 4: Refactor dashboard.ejs template to card loop

**Files:**
- Modify: `views/dashboard.ejs` — replace hardcoded chart sections with card loop + add-chart picker

**Consumes:**
- `chartData` (keyed by card key), `cardList` (ordered array of `{ key, label, type, category }`), `layoutMode`, `availableCards` from Task 3

This is the largest task. The template changes from rendering each chart type in a fixed sequence to a single loop over `cardList`.

- [ ] **Step 1: Add CSS for card header buttons and add-chart picker**

Add to the `<style>` block in dashboard.ejs, before the closing `</style>`:

```css
.card-header{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.card-header h2{flex:1;margin:0}
.card-btn{background:none;border:1px solid var(--line);color:var(--muted);width:28px;height:28px;padding:0;border-radius:6px;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;margin:0}
.card-btn:hover{border-color:var(--teal);color:var(--teal)}
.card-btn.remove:hover{border-color:#b91c1c;color:#b91c1c}
.add-chart-bar{margin-top:16px;text-align:center}
.add-chart-bar button{width:auto;padding:10px 24px}
.picker{display:none;margin-top:12px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.picker.open{display:block}
.picker h3{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:16px 0 8px;font-weight:600}
.picker h3:first-child{margin-top:0}
.picker-grid{display:flex;flex-wrap:wrap;gap:8px}
.picker-item{padding:6px 14px;border:1px solid var(--line);border-radius:8px;font-size:13px;cursor:pointer;text-decoration:none;color:var(--ink);background:var(--card)}
.picker-item:hover{border-color:var(--teal);color:var(--teal)}
.picker-item.no-data{opacity:.4;pointer-events:none}
.reset-link{font-size:13px;color:var(--muted);margin-top:8px;display:inline-block}
```

- [ ] **Step 2: Replace the chart rendering sections with a card loop**

Replace everything between `<% } else { %>` (line 122, after "No health data" check) and the closing `<% } %>` (line 228, before build footer) with the new card loop. Keep the tiles section unchanged at the top.

The new card loop:

```ejs
  <div class="tiles">
    <% tiles.forEach(function(t) { %>
      <div class="tile">
        <div class="label"><%= t.label %></div>
        <div class="value"><% if (t.value === null || t.value === undefined) { %>—<% } else { %><%= typeof t.value === "number" ? t.value.toLocaleString("en-US") : t.value %><% if (t.unit) { %><span class="unit"><%= t.unit %></span><% } } %></div>
      </div>
    <% }); %>
  </div>

  <% cardList.forEach(function(card, idx) {
       var cd = chartData[card.key] || {};
  %>
    <div class="card" data-card="<%= card.key %>">
      <div class="card-header">
        <h2><%= card.label %><% if (card.type === 'line' || card.type === 'bar') { var dm = cd; if (dm && dm.unit) { %> <span class="unit">(<%= dm.unit %>)</span><% } } %><% if (card.key === 'hr_split') { %> <span class="unit">(bpm)</span><% } %></h2>
        <% if (layoutMode === 'custom') { %>
          <% if (idx > 0) { %>
            <form method="post" action="/dashboard/layout/reorder" style="display:inline">
              <input type="hidden" name="card" value="<%= card.key %>">
              <input type="hidden" name="dir" value="up">
              <input type="hidden" name="range" value="<%= range %>">
              <button type="submit" class="card-btn" title="Move up">&uarr;</button>
            </form>
          <% } %>
          <% if (idx < cardList.length - 1) { %>
            <form method="post" action="/dashboard/layout/reorder" style="display:inline">
              <input type="hidden" name="card" value="<%= card.key %>">
              <input type="hidden" name="dir" value="down">
              <input type="hidden" name="range" value="<%= range %>">
              <button type="submit" class="card-btn" title="Move down">&darr;</button>
            </form>
          <% } %>
          <form method="post" action="/dashboard/layout/remove" style="display:inline">
            <input type="hidden" name="card" value="<%= card.key %>">
            <input type="hidden" name="range" value="<%= range %>">
            <button type="submit" class="card-btn remove" title="Remove">&times;</button>
          </form>
        <% } %>
      </div>

      <% if (card.type === 'bar' || card.type === 'line') { %>
        <div class="chart" id="chart-<%= card.key %>"></div>
        <div class="legend">
          <span><i style="background:#0FA9A0"></i><%= card.label %></span>
          <% if (cd.trend) { %><span><i style="background:#34D399"></i>7-day average</span><% } %>
          <% (cd.sources || []).forEach(function(s) { %>
            <span><i style="background:<%= s.color %>"></i><%= sourceNames[s.source] || s.source %></span>
          <% }); %>
          <% if (cd.days) { %><span><%= cd.days %> days with data</span><% } %>
        </div>
      <% } else if (card.type === 'band') { %>
        <div class="chart" id="chart-<%= card.key %>"></div>
        <div class="legend">
          <span><i style="background:rgba(15,169,160,.25)"></i>Daily range</span>
          <span><i style="background:#0FA9A0"></i>Average</span>
          <% (cd.sources || []).forEach(function(s) { %>
            <span><i style="background:<%= s.color %>"></i><%= sourceNames[s.source] || s.source %></span>
          <% }); %>
        </div>
      <% } else if (card.key === 'sleep') { %>
        <div class="chart" id="chart-sleep"></div>
        <div class="legend">
          <span><i style="background:#1e3a8a"></i>Deep</span>
          <span><i style="background:#3b82f6"></i>Light</span>
          <span><i style="background:#a78bfa"></i>REM</span>
          <span><i style="background:#cbd5e1"></i>Awake</span>
        </div>
      <% } else if (card.key === 'hr_split') { %>
        <div class="chart" id="chart-hr-split"></div>
        <div class="legend">
          <span><i style="background:rgba(245,158,11,.30)"></i>During a workout</span>
          <span><i style="background:rgba(15,169,160,.25)"></i>Outside workouts</span>
          <span>Bands show the day's range; lines show the average.</span>
        </div>
      <% } else if (card.key === 'workouts') { %>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Activity</th><th class="num">Sessions</th><th class="num">Total time</th></tr></thead>
            <tbody>
            <% (cd.rows || []).forEach(function(w) { %>
              <tr>
                <td><%= w.name %></td>
                <td class="num"><%= w.sessions %></td>
                <td class="num"><%= Math.floor(w.minutes / 60) %>h <%= String(w.minutes % 60).padStart(2, "0") %>m</td>
              </tr>
            <% }); %>
            </tbody>
          </table>
        </div>
      <% } else if (card.key === 'recent') { %>
        <div class="table-scroll">
          <table>
            <thead><tr>
              <th>Day</th><th class="num">Steps</th><th class="num">Distance (m)</th>
              <th class="num">Active kcal</th><th class="num">Sleep</th><th class="num">Resting HR</th>
            </tr></thead>
            <tbody>
            <% (cd.rows || recent).forEach(function(d) { var k = toKey(d.day); %>
              <tr>
                <td><a href="/dashboard/<%= k %>"><%= k %></a></td>
                <td class="num"><%= d.steps == null ? "—" : Number(d.steps).toLocaleString("en-US") %></td>
                <td class="num"><%= d.distance == null ? "—" : Math.round(d.distance).toLocaleString("en-US") %></td>
                <td class="num"><%= d.active_calories == null ? "—" : Math.round(d.active_calories) %></td>
                <td class="num"><%= d.sleep_duration_minutes == null ? "—" : Math.floor(d.sleep_duration_minutes / 60) + "h " + String(Math.round(d.sleep_duration_minutes % 60)).padStart(2, "0") + "m" %></td>
                <td class="num"><%= d.resting_heart_rate == null ? "—" : Math.round(d.resting_heart_rate) %></td>
              </tr>
            <% }); %>
            </tbody>
          </table>
        </div>
      <% } %>
    </div>
  <% }); %>

  <%# Add chart button + picker %>
  <div class="add-chart-bar">
    <button onclick="document.getElementById('chart-picker').classList.toggle('open')">+ Add Chart</button>
    <% if (layoutMode === 'custom') { %>
      <br><a href="#" class="reset-link" onclick="fetch('/dashboard/layout',{method:'DELETE'}).then(()=>location.reload());return false">Reset to default</a>
    <% } %>
  </div>

  <div id="chart-picker" class="picker">
    <% var cats = {};
       var allCatalogCards = (availableCards || []).concat(
         (cardList || []).map(function(c) { return Object.assign({}, c, { added: true }); })
       );
       // Group available cards by category
       (availableCards || []).forEach(function(c) {
         if (!cats[c.category]) cats[c.category] = [];
         cats[c.category].push(c);
       });
       var catOrder = ["Activity", "Heart & Lungs", "Body", "Nutrition", "Sleep & Recovery", "Workouts", "Overview"];
       catOrder.forEach(function(cat) {
         if (!cats[cat] || !cats[cat].length) return;
    %>
      <h3><%= cat %></h3>
      <div class="picker-grid">
        <% cats[cat].forEach(function(c) { %>
          <form method="post" action="/dashboard/layout/add?range=<%= range %>" style="display:inline">
            <input type="hidden" name="card" value="<%= c.key %>">
            <button type="submit" class="picker-item"><%= c.label %></button>
          </form>
        <% }); %>
      </div>
    <% }); %>
    <% if (!availableCards || !availableCards.length) { %>
      <p style="color:var(--muted);font-size:13px">All available charts are already on your dashboard.</p>
    <% } %>
  </div>
```

- [ ] **Step 3: Update the client-side drawAll() and DATA variable**

Replace the old `const DATA = <%- JSON.stringify(charts) %>` and `drawAll()` with the new card-key-based approach:

```js
const CHART_DATA = <%- JSON.stringify(chartData).replace(/</g, '\\u003c') %>;
const CARD_LIST = <%- JSON.stringify(cardList).replace(/</g, '\\u003c') %>;
const SOURCE_NAMES = <%- JSON.stringify(sourceNames || {}).replace(/</g, '\\u003c') %>;
function srcName(pkg) { return SOURCE_NAMES[pkg] || pkg; }
```

Update `drawAll()`:

```js
function drawAll() {
  CARD_LIST.forEach((card) => {
    const cd = CHART_DATA[card.key];
    if (!cd) return;
    const id = `chart-${card.key}`;

    if (card.type === "bar") {
      const digits = maxOf(cd.points.map((p) => p.value)) < 10 ? 2 : 0;
      barChart(id, cd.points, cd.trend, cd.unit, cd.sources, cd.filtered);
    } else if (card.type === "line") {
      const digits = maxOf(cd.points.map((p) => p.value)) < 10 ? 2 : 0;
      lineChart(id, cd.points, cd.unit, digits, cd.sources, cd.filtered);
    } else if (card.type === "band") {
      bandChart(id, cd.points, cd.sources, cd.filtered);
    } else if (card.key === "sleep") {
      stackedChart("chart-sleep", cd.points, ["deep", "light", "rem", "awake"],
        ["#1e3a8a", "#3b82f6", "#a78bfa", "#cbd5e1"]);
    } else if (card.key === "hr_split") {
      splitBandChart("chart-hr-split", cd.points);
    }
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add views/dashboard.ejs
git commit -m "feat: refactor dashboard template to card loop with add/remove/reorder"
```

---

### Task 5: Add reorder and remove endpoints

**Files:**
- Modify: `src/routes/pages.js` — add reorder and remove POST endpoints

**Consumes:**
- `stats.getLayout(userId)`, `stats.saveLayout(userId, cards)`, `stats.CARD_CATALOG` from Task 1

The template uses form POSTs for reorder/remove (no client-side JS needed). These endpoints manipulate the cards array and redirect back.

- [ ] **Step 1: Add reorder and remove endpoints to pages.js**

```js
pagesRouter.post("/dashboard/layout/reorder", requireAuth, async (req, res) => {
  try {
    const { card, dir, range } = req.body;
    const existing = await stats.getLayout(req.user.id);
    if (!existing) return res.redirect(`/dashboard?range=${range || 30}`);
    const idx = existing.indexOf(card);
    if (idx === -1) return res.redirect(`/dashboard?range=${range || 30}`);
    const swap = dir === "up" ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= existing.length) return res.redirect(`/dashboard?range=${range || 30}`);
    [existing[idx], existing[swap]] = [existing[swap], existing[idx]];
    await stats.saveLayout(req.user.id, existing);
    res.redirect(`/dashboard?range=${range || 30}`);
  } catch (err) {
    console.error("POST /dashboard/layout/reorder failed", err);
    res.redirect("/dashboard");
  }
});

pagesRouter.post("/dashboard/layout/remove", requireAuth, async (req, res) => {
  try {
    const { card, range } = req.body;
    const existing = await stats.getLayout(req.user.id);
    if (!existing) return res.redirect(`/dashboard?range=${range || 30}`);
    const cards = existing.filter((k) => k !== card);
    await stats.saveLayout(req.user.id, cards);
    res.redirect(`/dashboard?range=${range || 30}`);
  } catch (err) {
    console.error("POST /dashboard/layout/remove failed", err);
    res.redirect("/dashboard");
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/pages.js
git commit -m "feat: add reorder and remove layout endpoints"
```

---

### Task 6: End-to-end verification

**Files:** None (testing only)

- [ ] **Step 1: Start the dev server**

```bash
cd web && npm run dev
```

- [ ] **Step 2: Test default mode**

Open `/dashboard` in browser. Verify all charts render in the same order as before. The "+ Add Chart" button should appear at the bottom. No reorder/remove buttons visible yet.

- [ ] **Step 3: Test adding a chart**

Click "+ Add Chart", pick a metric. Verify the page reloads with that metric visible. Now in custom mode — reorder and remove buttons should appear on all cards.

- [ ] **Step 4: Test reorder**

Click up/down arrows on a card. Verify order changes and persists after page reload.

- [ ] **Step 5: Test remove**

Click X on a card. Verify it disappears. Click "+ Add Chart" — the removed card should appear in the picker.

- [ ] **Step 6: Test reset**

Click "Reset to default". Verify all cards return in the original order, reorder/remove buttons disappear.

- [ ] **Step 7: Test persistence across logout/login**

Customize the layout, log out, log back in. Verify layout is preserved.

- [ ] **Step 8: Commit any fixes, then final commit**

```bash
git add -A
git commit -m "feat: custom dashboard layout — complete"
```
