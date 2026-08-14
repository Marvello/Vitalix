import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.JWT_SECRET ||= "test-secret";
process.env.DATABASE_URL ||= "postgres://x";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const migrationPath = resolve(__dirname, "../migrations/1722700000000_ai_recommendations.cjs");

describe("AI recommendations migration", () => {
  test("migration file exists and exports up/down", () => {
    const migration = require(migrationPath);
    assert.equal(typeof migration.up, "function");
    assert.equal(typeof migration.down, "function");
  });

  test("migration creates expected schema via up()", () => {
    const migration = require(migrationPath);
    const calls = [];
    const fakePgm = {
      createTable: (name, cols) => calls.push({ op: "createTable", name, cols }),
      addConstraint: (table, name, def) => calls.push({ op: "addConstraint", table, name, def }),
      addColumn: (table, cols) => calls.push({ op: "addColumn", table, cols }),
      func: (s) => s,
    };

    migration.up(fakePgm);

    const createCall = calls.find((c) => c.op === "createTable");
    assert.equal(createCall.name, "ai_recommendations");
    assert.ok(createCall.cols.user_id);
    assert.ok(createCall.cols.day);
    assert.ok(createCall.cols.recommendation_text);
    assert.ok(createCall.cols.metrics_snapshot);
    assert.ok(createCall.cols.provider);
    assert.ok(createCall.cols.model);
    assert.ok(createCall.cols.prompt_tokens);
    assert.ok(createCall.cols.completion_tokens);

    const constraintCall = calls.find((c) => c.op === "addConstraint");
    assert.deepEqual(constraintCall.def.unique, ["user_id", "day"]);

    const colCall = calls.find((c) => c.op === "addColumn");
    assert.equal(colCall.table, "users");
    assert.ok(colCall.cols.ai_config);
  });

  test("migration down() drops table and column", () => {
    const migration = require(migrationPath);
    const calls = [];
    const fakePgm = {
      dropTable: (name) => calls.push({ op: "dropTable", name }),
      dropColumn: (table, col) => calls.push({ op: "dropColumn", table, col }),
    };

    migration.down(fakePgm);

    assert.ok(calls.find((c) => c.op === "dropTable" && c.name === "ai_recommendations"));
    assert.ok(calls.find((c) => c.op === "dropColumn" && c.table === "users" && c.col === "ai_config"));
  });
});
