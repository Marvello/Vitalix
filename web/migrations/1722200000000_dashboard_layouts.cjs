exports.up = (pgm) => {
  pgm.createTable("dashboard_layouts", {
    user_id: {
      type: "integer",
      primaryKey: true,
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    cards: { type: "jsonb", notNull: true, default: "'[]'" },
  });
};

exports.down = (pgm) => {
  pgm.dropTable("dashboard_layouts");
};
