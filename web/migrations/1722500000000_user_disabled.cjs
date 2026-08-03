exports.up = (pgm) => {
  pgm.addColumn("users", {
    disabled_at: { type: "timestamptz" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("users", "disabled_at");
};
