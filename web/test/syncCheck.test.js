import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deadTokens, runSyncCheck, STALE_USERS_SQL } from "../src/syncCheck.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("014_no_sync_notify migration", () => {
  const sql = readFileSync(resolve(__dirname, "../db/migrations/014_no_sync_notify.sql"), "utf8");
  test("adds users.no_sync_notified_at", () => {
    assert.match(sql, /ALTER TABLE users ADD COLUMN no_sync_notified_at timestamptz/);
  });
});

describe("STALE_USERS_SQL", () => {
  test("requires a token, a prior sync, staleness, and renotify gap", () => {
    assert.match(STALE_USERS_SQL, /JOIN fcm_tokens/);            // must have a device token
    assert.match(STALE_USERS_SQL, /MAX\(s\.received_at\) IS NOT NULL/); // synced before (not never)
    assert.match(STALE_USERS_SQL, /MAX\(s\.received_at\) < now\(\)/);   // now stale
    assert.match(STALE_USERS_SQL, /no_sync_notified_at IS NULL/);       // dedup
  });
});

describe("deadTokens", () => {
  test("selects only permanently-dead tokens", () => {
    const tokens = ["good", "gone", "bad", "transient"];
    const resp = {
      responses: [
        { success: true },
        { success: false, error: { code: "messaging/registration-token-not-registered" } },
        { success: false, error: { code: "messaging/invalid-registration-token" } },
        { success: false, error: { code: "messaging/internal-error" } }, // transient — keep
      ],
    };
    assert.deepEqual(deadTokens(tokens, resp), ["gone", "bad"]);
  });
});

describe("runSyncCheck", () => {
  test("skips when firebase is disabled", async () => {
    const r = await runSyncCheck({ messaging: null, query: () => assert.fail("no query") });
    assert.equal(r.skipped, "firebase disabled");
  });

  test("notifies, prunes dead tokens, stamps, and counts", async () => {
    const calls = [];
    const query = async (text, params) => {
      calls.push({ text, params });
      if (text === STALE_USERS_SQL) {
        return { rows: [{ id: 7, tokens: ["live", "dead"] }] };
      }
      return { rows: [] };
    };
    const messaging = {
      sendEachForMulticast: async ({ tokens, data }) => {
        assert.deepEqual(data, { type: "no_sync" });
        assert.deepEqual(tokens, ["live", "dead"]);
        return {
          successCount: 1,
          responses: [
            { success: true },
            { success: false, error: { code: "messaging/registration-token-not-registered" } },
          ],
        };
      },
    };

    const r = await runSyncCheck({ query, messaging });
    assert.deepEqual(r, { checked: 1, notified: 1, pruned: 1 });
    assert.ok(calls.some((c) => /DELETE FROM fcm_tokens/.test(c.text) && c.params[0].includes("dead")));
    assert.ok(calls.some((c) => /UPDATE users SET no_sync_notified_at/.test(c.text) && c.params[0] === 7));
  });

  test("does not stamp when every send fails", async () => {
    const calls = [];
    const query = async (text) => {
      calls.push(text);
      return text === STALE_USERS_SQL ? { rows: [{ id: 9, tokens: ["dead"] }] } : { rows: [] };
    };
    const messaging = {
      sendEachForMulticast: async () => ({
        successCount: 0,
        responses: [{ success: false, error: { code: "messaging/registration-token-not-registered" } }],
      }),
    };
    const r = await runSyncCheck({ query, messaging });
    assert.equal(r.notified, 0);
    assert.equal(r.pruned, 1);
    assert.ok(!calls.some((t) => /UPDATE users SET no_sync_notified_at/.test(t)));
  });
});
