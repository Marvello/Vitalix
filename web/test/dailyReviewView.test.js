import { test } from "node:test";
import assert from "node:assert/strict";
import ejs from "ejs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../views/daily-review.ejs");
const base = { email: "a@b.c", userRole: "user", date: "2026-11-03", canGenerate: true, dayData: {}, deltas: {}, baseline7d: {}, readiness: null, alerts: [], journal: [], digest: null };

test("feedback buttons exist (hidden) with no recommendation so Generate can reveal them", async () => {
  const html = await ejs.renderFile(file, { ...base, recommendation: null });
  assert.match(html, /<div class="thumbs" id="thumbs" data-value="0" hidden>/);
  assert.match(html, /id="thumb-up"[^>]*onclick="sendFeedback\(1\)"/);
  assert.match(html, /thumbs"\)\.hidden = false|getElementById\('thumbs'\)\.hidden = false|box\.hidden = false/);
});

test("with a recommendation the buttons are visible and carry its feedback", async () => {
  const html = await ejs.renderFile(file, { ...base, recommendation: { recommendation_text: "hi", feedback: 1 } });
  assert.match(html, /<div class="thumbs" id="thumbs" data-value="1">/);
});
