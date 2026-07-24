// Records the Health Connect app that wrote each sample/exercise (dataOrigin
// package name), so data can be traced back to its source device or app.
exports.up = (pgm) => {
  pgm.addColumn("samples", { source: { type: "text" } });
  pgm.addColumn("exercises", { source: { type: "text" } });
  pgm.createIndex("samples", "source");
};

exports.down = (pgm) => {
  pgm.dropIndex("samples", "source");
  pgm.dropColumn("exercises", "source");
  pgm.dropColumn("samples", "source");
};
