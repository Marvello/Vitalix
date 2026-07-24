# Source Filter & Per-Source Comparison — Design

Date: 2026-07-24
Component: `web/` (self-hosted Vitalix receiver + dashboard)

## Goal

Let a user filter dashboard charts by the **data source** (Health Connect
`dataOrigin` package — the app/device that wrote each reading) and **compare
sources by overlaying one line per source** on each metric chart. This exposes
disagreement or double-reporting between apps (e.g. Google Fit vs Samsung Health
both writing `steps`).

## Background / constraints

Source is stored only in the granular per-reading stores (`samples`, `records`),
not in the day rollups (`health_days`, `day_aggregates`) that currently feed the
dashboard charts (via `stats.js`). Rolling readings up to a day discards source.

Decision: **add a source dimension to the rollup layer** via a new dedicated
per-source rollup table, rather than re-pointing the dashboard at raw `records`
or restructuring the wide `health_days` table. This keeps `health_days` as the
source-agnostic "combined" rollup (default view unchanged) and gives the
dashboard fast, indexed per-source reads.

Charts are hand-rolled client-side SVG in `views/dashboard.ejs`, fed by JSON
`series` from the server. Each metric series carries a `points` array. The view
already draws multiple overlaid `<path>` elements for split series
(`dashboard.ejs:510-512`), so per-source overlay reuses that pattern.

## Data model

New table:

```
day_source_metrics
  id           bigserial PK
  user_id      bigint  NOT NULL  FK users ON DELETE CASCADE
  day          date    NOT NULL
  metric       text    NOT NULL   -- records `type` vocabulary (camelCase):
                                   --   'steps','restingHeartRate','heartRate',...
  source       text    NOT NULL   -- HC dataOrigin package; null coalesced to '(unknown)'
  value_num    double precision   -- representative daily value per aggregationFor() rule
  min          double precision   -- distribution metrics only
  max          double precision
  avg          double precision
  count        integer
  UNIQUE (user_id, day, metric, source)   -- constraint: day_source_metrics_identity
  INDEX (user_id, metric, day)
```

- `metric` uses the `records.type` vocabulary (the store that carries source),
  NOT the `health_days` snake_case column names. Label/unit mapping to the UI
  goes through the existing `DAY_METRICS` / `metricLabel` catalog in
  `chartData.js` / `stats.js`; a small alias map bridges the two vocabularies
  where they differ.
- `source` is `NOT NULL`; null `dataOrigin` is coalesced to `'(unknown)'` at
  write time so it groups predictably and the unique key holds.
- `value_num` is the per-source daily representative value chosen by
  `aggregationFor(metric)` from `records.js`: `sum` metrics summed, `last`
  metrics take the latest reading, distribution metrics store min/max/avg (and
  `value_num` = avg for a single-line overlay).

`health_days` and `day_aggregates` are **unchanged**.

## Write path — ingest

In `persist.js`, inside the same transaction that writes `records`: group the
incoming readings by `(day, metric, source)`, apply `aggregationFor()`, and
**upsert** into `day_source_metrics` keyed on `day_source_metrics_identity`
(`ON CONFLICT … DO UPDATE`). Re-syncs and overlapping backfill windows update in
place rather than duplicating, matching the existing `records` idempotency
model.

The grouping derives from the same reading list already mapped for `records`;
no new payload fields are required.

## Backfill

`records` already holds full history with source, so the migration seeds
`day_source_metrics` in one statement:

```sql
INSERT INTO day_source_metrics (user_id, day, metric, source, value_num, min, max, avg, count)
SELECT user_id,
       (start_at AT TIME ZONE 'UTC')::date AS day,
       type AS metric,
       COALESCE(source, '(unknown)') AS source,
       -- value_num chosen per aggregation rule; sum-vs-avg handled in migration
       ...,
       min(value_num), max(value_num), avg(value_num), count(*)
FROM records
GROUP BY user_id, day, metric, source
ON CONFLICT ON CONSTRAINT day_source_metrics_identity DO NOTHING;
```

The `value_num` expression branches on the aggregation rule per metric; the
migration encodes the same `SUM`/`LAST`/distribution split as `records.js`.
(Implementation detail: either a CASE over a metric→rule mapping, or per-rule
INSERT passes. Resolved in the plan.)

## Read layer — `stats.js`

Two new functions:

- `availableSources(userId, from, to)` → `string[]` of distinct sources present
  in the range. Drives the filter chips.
- `sourceSeries(userId, from, to, columns, sources)` → per metric → per source →
  daily points `{ day, value }` (plus min/max for band metrics). Returns only
  the requested `columns` and `sources`.

Both read `day_source_metrics` with the `(user_id, metric, day)` index.

## Dashboard route — `routes/pages.js`

`GET /dashboard` additionally:

- reads `?sources=a,b` (comma-separated, mirroring the existing `?range=`
  handling), validated against `availableSources`;
- calls `availableSources` and, when sources are selected, `sourceSeries`;
- passes `availableSources`, `selectedSources`, and per-metric source series
  into the render.

No sources selected → identical to current behavior (combined line only),
fully backward-compatible.

## UI — `views/dashboard.ejs`

- **Sources filter**: a chip/checkbox row styled like the existing range
  selector. Each chip is a source; toggling reloads with an updated `?sources=`
  query string. Selected state is driven entirely by the query param (no client
  state to persist).
- **Overlay rendering**: for line and band metrics, when sources are selected,
  the client SVG draws:
  - the **combined line** from `health_days` (kept — total vs contributors), plus
  - **one colored path per selected source** from the source series,
  - a legend chip per line (combined + each source).
  Reuses the existing multi-path draw pattern. Colors come from a small stable
  palette keyed by source name so a given source keeps its color across reloads.

## Scope (YAGNI for v1)

- Overlay covers **line and band metrics only** — the source-carrying ones.
  Sleep stacked chart, exercise breakdown, and summary tiles remain combined /
  unchanged.
- Source filtering applies to the main `/dashboard` view. The day-detail page
  (`/dashboard/:date`) already shows per-sample source and is out of scope here.
- No server-side source persistence per user (no "default source" setting);
  selection lives in the URL only.

## Accepted caveat

The combined `health_days` total and the sum of per-source values can differ —
if the app pre-dedupes before sending, or two apps double-report the same
metric. This is expected and is exactly the disagreement the feature surfaces.
Combined line = `health_days`; source lines = `day_source_metrics`.

## Testing

- `records.js` aggregation rules already unit-tested; add unit tests for the
  `(day, metric, source)` grouping → rollup value mapping (pure, no DB).
- `stats.js` `sourceSeries` shaping: unit-test the row→series transform with
  fixture rows.
- Migration up/down + backfill: verify `day_source_metrics` populates from a
  seeded `records` set and the unique key dedupes re-runs.

## Files touched

- `web/migrations/<ts>_day_source_metrics.cjs` — new table, index, backfill.
- `web/src/persist.js` — per-source rollup upsert at ingest.
- `web/src/records.js` — export the metric→rule mapping if not already reusable.
- `web/src/stats.js` — `availableSources`, `sourceSeries`.
- `web/src/routes/pages.js` — `?sources=` handling, pass data to render.
- `web/views/dashboard.ejs` — sources filter chips + per-source overlay draw.
- `web/test/…` — grouping + series-shaping unit tests.
- `docs/database-erd.md` — add `day_source_metrics` to the ERD.
