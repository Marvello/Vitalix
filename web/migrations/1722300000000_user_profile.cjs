exports.up = (pgm) => {
  pgm.addColumn("users", {
    profile_height_m: { type: "double precision" },
    bmi_scale: { type: "text", notNull: true, default: "standard" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("users", "bmi_scale");
  pgm.dropColumn("users", "profile_height_m");
};
