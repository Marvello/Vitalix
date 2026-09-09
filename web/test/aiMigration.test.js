import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(__dirname, "../db/migrations/013_ai_recommendations.sql"),
  "utf8",
);

describe("013_ai_recommendations migration", () => {
  test("creates ai_recommendations with the expected columns", () => {
    assert.match(sql, /CREATE TABLE ai_recommendations/);
    for (const col of [
      "user_id", "day", "provider", "model", "recommendation_text",
      "metrics_snapshot", "prompt_tokens", "completion_tokens",
    ]) {
      assert.match(sql, new RegExp(`\\b${col}\\b`), `missing column ${col}`);
    }
  });

  test("enforces one recommendation per user per day", () => {
    assert.match(sql, /UNIQUE \(user_id, day\)/);
  });

  test("adds users.ai_config", () => {
    assert.match(sql, /ALTER TABLE users ADD COLUMN ai_config jsonb/);
  });
});
