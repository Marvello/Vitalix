import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x";
process.env.JWT_SECRET ??= "test-secret";
const { pushToUser } = await import("../src/push.js");

const mk = (tokens, send) => {
  const deleted = [];
  const query = async (text, p) => {
    if (text.includes("array_agg")) return { rows: [{ tokens }] };
    deleted.push(...p[0]);
    return { rows: [] };
  };
  return { deleted, deps: { query, messaging: { sendEachForMulticast: send } } };
};

test("sends, prunes dead tokens, counts them", async () => {
  const { deps, deleted } = mk(["a", "b"], async () => ({
    successCount: 1,
    responses: [{ success: true }, { success: false, error: { code: "messaging/registration-token-not-registered" } }],
  }));
  assert.deepEqual(await pushToUser(deps, 1, { type: "x" }), { sent: true, pruned: 1 });
  assert.deepEqual(deleted, ["b"]);
});

test("no tokens or no messaging: sent false", async () => {
  assert.deepEqual(await pushToUser(mk([], async () => {}).deps, 1, {}), { sent: false, pruned: 0 });
  assert.deepEqual(await pushToUser({ query: async () => ({ rows: [] }), messaging: null }, 1, {}), { sent: false, pruned: 0 });
});

test("an FCM throw is logged, not rethrown", async () => {
  const log = console.error; console.error = () => {};
  try {
    assert.deepEqual(await pushToUser(mk(["a"], async () => { throw new Error("boom"); }).deps, 1, { type: "x" }), { sent: false, pruned: 0 });
  } finally { console.error = log; }
});
