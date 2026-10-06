import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x";
process.env.JWT_SECRET ??= "test-secret";
const { zealotUpdatePush } = await import("../src/routes/webhooks.js");

// Body as Zealot actually posts it (default template, flat).
const body = {
  event: "upload_events", app_name: "Vitalix Beta Android", release_type: "beta",
  release_version: "1.5.6", build_version: "15", branch: "main",
  changelog: "- fix(ai): complete-day insights", install_url: "https://zealot.example/download/releases/42",
};

test("maps a beta upload to the beta topic with version_code and changelog", () => {
  assert.deepEqual(zealotUpdatePush(body), {
    topic: "app-updates-beta",
    data: {
      type: "app_update", version: "1.5.6", version_code: "15",
      download_url: "https://zealot.example/download/releases/42",
      changelog: "- fix(ai): complete-day insights",
    },
  });
});

test("production uploads go to the production topic; changelog arrays are flattened", () => {
  const p = zealotUpdatePush({ ...body, release_type: "release", changelog: [{ message: "a" }, { message: "b" }] });
  assert.equal(p.topic, "app-updates");
  assert.equal(p.data.changelog, "- a\n- b");
});

test("ignores non-upload events and uploads without an install url", () => {
  assert.equal(zealotUpdatePush({ ...body, event: "download_events" }), null);
  assert.equal(zealotUpdatePush({ ...body, install_url: "" }), null);
  assert.equal(zealotUpdatePush(undefined), null);
});
