exports.up = (pgm) => {
  pgm.createTable("fcm_tokens", {
    id: "id",
    user_id: {
      type: "integer",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    token: { type: "text", notNull: true, unique: true },
    app_id: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("fcm_tokens", "user_id");
};

exports.down = (pgm) => {
  pgm.dropTable("fcm_tokens");
};
