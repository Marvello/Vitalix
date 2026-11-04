-- 018_drop_samples: readings live in records only. Destructive: back up the DB before deploying.
-- Keep sample-only readings (pre-004 data, UID-less rows) by copying them into records first.
-- One row per (user, type, start, source): the same reading can sit under two day_ids, while
-- two sources at one instant are two readings. Lowest sample id wins, deterministically.
INSERT INTO records (user_id, type, hc_id, start_at, end_at, value_num, value_secondary, value_text, source, meta)
SELECT DISTINCT ON (hd.user_id, s.metric, s.start_at, coalesce(s.source, ''))
       hd.user_id, s.metric, 'legacy-sample:' || s.id, s.start_at, s.end_at,
       s.value_num, s.value_secondary, s.value_text, s.source, s.meta
  FROM samples s
  JOIN health_days hd ON hd.id = s.day_id
 WHERE NOT EXISTS (SELECT 1 FROM records r
                    WHERE r.user_id = hd.user_id AND r.type = s.metric AND r.start_at = s.start_at
                      AND r.source IS NOT DISTINCT FROM s.source)
 ORDER BY hd.user_id, s.metric, s.start_at, coalesce(s.source, ''), s.id
ON CONFLICT DO NOTHING;

DROP TABLE samples;
