// Raw per-reading storage: every Health Connect record at native granularity,
// keyed on its record UID so re-syncs and overlapping backfill windows upsert
// instead of duplicating. Parallel source of truth to the day rollups.
exports.up = (pgm) => {
  pgm.createTable("records", {
    id: "bigserial",
    user_id: { type: "bigint", notNull: true, references: "users", onDelete: "CASCADE" },
    type: { type: "text", notNull: true },
    hc_id: { type: "text", notNull: true },
    start_at: { type: "timestamptz", notNull: true },
    end_at: { type: "timestamptz" },
    value_num: { type: "double precision" },
    value_secondary: { type: "double precision" },
    value_text: { type: "text" },
    source: { type: "text" },
    received_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("records", "records_pkey", { primaryKey: "id" });
  pgm.addConstraint("records", "records_identity", { unique: ["user_id", "hc_id", "start_at"] });
  pgm.createIndex("records", ["user_id", "type", "start_at"]);

  pgm.addColumn("exercises", { hc_id: { type: "text" } });
  pgm.addConstraint("exercises", "exercises_identity", { unique: ["day_id", "hc_id"] });
};

exports.down = (pgm) => {
  pgm.dropConstraint("exercises", "exercises_identity");
  pgm.dropColumn("exercises", "hc_id");
  pgm.dropTable("records");
};
