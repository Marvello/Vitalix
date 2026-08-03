/**
 * Strip '#...' suffix from Health Connect package names in source columns.
 * e.g. "com.samsung.health#abc123" → "com.samsung.health"
 */
exports.up = (pgm) => {
  // samples
  pgm.sql(`
    UPDATE samples
       SET source = split_part(source, '#', 1)
     WHERE source LIKE '%#%'
  `);

  // exercises
  pgm.sql(`
    UPDATE exercises
       SET source = split_part(source, '#', 1)
     WHERE source LIKE '%#%'
  `);

  // records
  pgm.sql(`
    UPDATE records
       SET source = split_part(source, '#', 1)
     WHERE source LIKE '%#%'
  `);

  // day_source_metrics — after stripping, duplicate rows may exist for the same
  // (user_id, day, metric, source). Merge them by summing count and re-computing
  // min/max/avg, then delete the leftovers.
  pgm.sql(`
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
       AND c.clean_source = m.source
  `);

  // Delete duplicate rows that were not the "keeper" (rn > 1)
  pgm.sql(`
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
     WHERE id IN (SELECT id FROM cleaned WHERE rn > 1)
  `);
};

exports.down = () => {
  // Hash values are lost — cannot reverse.
};
