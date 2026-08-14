import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db.js";

test("ai_recommendations table and users.ai_config column exist", async () => {
  const resTable = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_name = 'ai_recommendations'"
  );
  assert.equal(resTable.rows.length, 1);

  const resCol = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'ai_config'"
  );
  assert.equal(resCol.rows.length, 1);
});

after(async () => {
  await pool.end();
});
