// Per-reading context enums (e.g. a blood-pressure reading's body position),
// captured on the granular stores only. Nullable, no backfill — historical
// readings never carried context. See src/persist.js (write) and the
// per-reading-meta design doc.
exports.up = (pgm) => {
  pgm.addColumns("samples", { meta: { type: "jsonb" } });
  pgm.addColumns("records", { meta: { type: "jsonb" } });
};

exports.down = (pgm) => {
  pgm.dropColumns("samples", ["meta"]);
  pgm.dropColumns("records", ["meta"]);
};
