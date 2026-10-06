import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x";
process.env.JWT_SECRET ??= "test-secret";
const { buildPrompts, cleanOutput, coverageNote, todayIn, shiftDay } = await import("../src/ai/recommendations.js");

const past = [
  { steps: 9000, sleep_duration_minutes: 420, total_calories: 2000 },
  { steps: 10000, sleep_duration_minutes: 0, total_calories: 2200 },
];

describe("buildPrompts", () => {
  test("labels values with units, 7-day average, day count and % change", () => {
    const { user, hasData, note } = buildPrompts({
      day: "2026-10-05",
      dayData: { steps: 4873, distance: 1691.49, total_calories: 1980, sleep_duration_minutes: 257, sleep_deep: 22, sleep_rem: 78, sleep_light: 143, sleep_awake: 14 },
      pastDays: past,
    });
    assert.equal(hasData, true);
    assert.equal(note, null);
    assert.match(user, /^Day: 2026-10-05 \(complete\)/);
    assert.match(user, /Steps: 4,873 \(7-day avg 9,500 over 2 days, -49%\)/);
    assert.match(user, /Distance: 1\.7 km\n/);
    assert.match(user, /Total calories burned: 1,980 kcal \(7-day avg 2,100 kcal over 2 days, -6%\)/);
    // 0 sleep in the past is a gap: averaged over 1 day, not 2.
    assert.match(user, /Sleep: 4 h 17 min \(7-day avg 7 h 0 min over 1 day, -39%\) — deep 22 min, light 2 h 23 min, REM 1 h 18 min, awake 14 min/);
  });

  test("zero or null is (not recorded), and falls back to the stage sum for sleep", () => {
    const { user } = buildPrompts({
      day: "2026-10-06",
      dayData: { steps: 0, sleep_duration_minutes: 0, sleep_light: 143, sleep_deep: 22, sleep_rem: 78, sleep_awake: 14 },
      pastDays: past,
    });
    assert.match(user, /Steps: \(not recorded\) \(7-day avg 9,500 over 2 days\)/);
    assert.match(user, /Sleep: 4 h 17 min/);
  });

  test("drops a stage breakdown that covers under 80% of the night", () => {
    const { user } = buildPrompts({
      day: "2026-10-05",
      dayData: { sleep_duration_minutes: 413, sleep_deep: 34, sleep_light: 76, sleep_rem: 6, sleep_awake: 23 },
    });
    assert.match(user, /Sleep: 6 h 53 min\n?$/m);
    assert.doesNotMatch(user, /REM/);
  });

  test("no recorded value and no workouts means no data", () => {
    assert.equal(buildPrompts({ day: "2026-10-06", dayData: { steps: 0 }, pastDays: past }).hasData, false);
    assert.equal(buildPrompts({ day: "2026-10-06" }).hasData, false);
  });

  test("lists workouts and marks incomplete data", () => {
    const { user, note } = buildPrompts({
      day: "2026-10-05",
      dayData: { steps: 3000 },
      workouts: [{ name: "Running", duration_minutes: 32 }],
      coverage: { partial: true, syncedThrough: "21:40", failedMetrics: ["SleepSessionRecord"] },
    });
    assert.match(user, /\(INCOMPLETE data\)/);
    assert.match(user, /Workouts: Running 32 min/);
    assert.match(user, /Not returned by Health Connect: sleep session/);
    assert.match(note, /last synced at 21:40/);
  });

  test("system prompt forbids reading calories as food and sets a plain-text format", () => {
    const { system } = buildPrompts({ day: "2026-10-05" });
    assert.match(system, /never food intake/);
    assert.match(system, /Plain text only/);
  });
});

describe("coverageNote", () => {
  test("null when complete", () => {
    assert.equal(coverageNote({ partial: false, failedMetrics: [] }), null);
    assert.equal(coverageNote(null), null);
  });
  test("names the cut-off and the missing metrics", () => {
    assert.equal(
      coverageNote({ partial: true, syncedThrough: "21:40", failedMetrics: ["HeartRateRecord", "SleepSessionRecord"] }),
      "- Data note: this day's data is incomplete (last synced at 21:40, so the rest of the day is missing; " +
        "Health Connect didn't return heart rate, sleep session). Treat these suggestions as tentative.",
    );
  });
});

test("cleanOutput strips headings, rules, bold and emoji", () => {
  const raw = "## Daily Check-In\n\n- **Steps dropped.** Walk more.\n---\n\nYou've got this 💪";
  assert.equal(cleanOutput(raw), "Daily Check-In\n\n- Steps dropped. Walk more.\n\nYou've got this");
});

test("todayIn follows the user's zone; shiftDay does calendar math", () => {
  const now = new Date("2026-10-05T20:00:00Z"); // 03:00 on Oct 6 in Jakarta
  assert.equal(todayIn("Asia/Jakarta", now), "2026-10-06");
  assert.equal(todayIn("UTC", now), "2026-10-05");
  assert.equal(todayIn("Not/AZone", now), "2026-10-05");
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
});
