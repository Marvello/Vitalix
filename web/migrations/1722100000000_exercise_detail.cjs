// Structured exercise detail (laps, segments, GPS route) that doesn't fit the
// flat columns. Nullable; only present when the writing app recorded it and the
// user granted the route permission.
exports.up = (pgm) => {
  pgm.addColumns("exercises", { detail: { type: "jsonb" } });
};
exports.down = (pgm) => {
  pgm.dropColumns("exercises", ["detail"]);
};
