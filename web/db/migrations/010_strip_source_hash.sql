-- 010_strip_source_hash: strip '#...' suffix from HC package names, merge dup
-- day_source_metrics rows (was 1722400000000_strip_source_hash.cjs)
UPDATE samples   SET source = split_part(source, '#', 1) WHERE source LIKE '%#%';
UPDATE exercises SET source = split_part(source, '#', 1) WHERE source LIKE '%#%';
UPDATE records   SET source = split_part(source, '#', 1) WHERE source LIKE '%#%';

-- Merge duplicate (user_id, day, metric, clean source) rows onto their keeper.
WITH cleaned AS (
  SELECT id,
         split_part(source, '#', 1) AS clean_source,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, day, metric, split_part(source, '#', 1)
           ORDER BY id
         ) AS rn
    FROM day_source_metrics
   WHERE source LIKE '%#%'
),
merged AS (
  SELECT user_id, day, metric,
         split_part(source, '#', 1) AS source,
         SUM(value_num) AS value_num,
         MIN(min) AS min,
         MAX(max) AS max,
         SUM(avg * count) / NULLIF(SUM(count), 0) AS avg,
         SUM(count) AS count
    FROM day_source_metrics
   WHERE source LIKE '%#%'
   GROUP BY user_id, day, metric, split_part(source, '#', 1)
)
UPDATE day_source_metrics dsm
   SET source    = m.source,
       value_num = m.value_num,
       min       = m.min,
       max       = m.max,
       avg       = m.avg,
       count     = m.count
  FROM merged m, cleaned c
 WHERE dsm.id = c.id
   AND c.rn = 1
   AND dsm.user_id = m.user_id
   AND dsm.day     = m.day
   AND dsm.metric  = m.metric
   AND c.clean_source = m.source;

-- Delete the non-keeper duplicates (rn > 1).
WITH cleaned AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, day, metric, split_part(source, '#', 1)
           ORDER BY id
         ) AS rn
    FROM day_source_metrics
   WHERE source LIKE '%#%'
)
DELETE FROM day_source_metrics
 WHERE id IN (SELECT id FROM cleaned WHERE rn > 1);
