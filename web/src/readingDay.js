/**
 * The one place that decides which local day a `records` reading belongs to:
 * its start_at day, except every stage of a sleepStage session goes to the day
 * the SESSION ends (latest stage end per user/type/hc_id), mirroring the phone's
 * bucketing. Used by stats.readingsInDays and the /api/records day/week buckets.
 *
 * `tz`, `from`, `to` are SQL expressions (placeholders). from/to are timestamptz
 * bounds of the start_at prune window and must already include slack for zones
 * and for a session's later stages (assumes sessions shorter than ~36h). The
 * window function runs over sleepStage rows only. $1 is the user id.
 */
export const readingsWithDay = ({ tz, from, to }) => `(
  SELECT s.*, (max(coalesce(s.end_at, s.start_at)) OVER (PARTITION BY s.user_id, s.type, s.hc_id) AT TIME ZONE ${tz})::date AS day
    FROM records s
   WHERE s.user_id = $1 AND s.type = 'sleepStage' AND s.start_at >= ${from} AND s.start_at < ${to}
  UNION ALL
  SELECT r.*, (r.start_at AT TIME ZONE ${tz})::date AS day
    FROM records r
   WHERE r.user_id = $1 AND r.type <> 'sleepStage' AND r.start_at >= ${from} AND r.start_at < ${to}
)`;
