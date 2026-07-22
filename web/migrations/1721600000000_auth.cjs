exports.up = (pgm) => {
  pgm.createExtension("citext", { ifNotExists: true });

  pgm.createTable("users", {
    id: "bigserial",
    email: { type: "citext", notNull: true, unique: true },
    password_hash: { type: "text", notNull: true },
    role: { type: "text", notNull: true, default: "user" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("users", "users_pkey", { primaryKey: "id" });

  const tokenTable = (name, extra = {}) => {
    pgm.createTable(name, {
      id: "bigserial",
      user_id: { type: "bigint", notNull: true, references: "users", onDelete: "CASCADE" },
      token_hash: { type: "text", notNull: true },
      expires_at: { type: "timestamptz", notNull: true },
      created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
      ...extra,
    });
    pgm.addConstraint(name, `${name}_pkey`, { primaryKey: "id" });
    pgm.createIndex(name, "token_hash");
  };
  tokenTable("refresh_tokens", { revoked_at: { type: "timestamptz" } });
  tokenTable("password_resets", { used_at: { type: "timestamptz" } });

  pgm.createTable("invites", {
    id: "bigserial",
    token_hash: { type: "text", notNull: true },
    email: { type: "citext", notNull: true },
    role: { type: "text", notNull: true, default: "user" },
    created_by: { type: "bigint", references: "users", onDelete: "SET NULL" },
    expires_at: { type: "timestamptz", notNull: true },
    used_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("invites", "invites_pkey", { primaryKey: "id" });
  pgm.createIndex("invites", "token_hash");

  // Per-user health data. Existing throwaway rows predate users → clear them.
  pgm.sql("DELETE FROM day_aggregates; DELETE FROM samples; DELETE FROM exercises; DELETE FROM health_days; DELETE FROM syncs;");
  pgm.addColumn("syncs", { user_id: { type: "bigint", notNull: true, references: "users", onDelete: "CASCADE" } });
  pgm.addColumn("health_days", { user_id: { type: "bigint", notNull: true, references: "users", onDelete: "CASCADE" } });
  pgm.dropConstraint("health_days", "health_days_day_key", { ifExists: true }); // the UNIQUE(day) auto-name
  pgm.addConstraint("health_days", "health_days_user_day_key", { unique: ["user_id", "day"] });
};

exports.down = (pgm) => {
  pgm.dropConstraint("health_days", "health_days_user_day_key");
  pgm.addConstraint("health_days", "health_days_day_key", { unique: "day" });
  pgm.dropColumn("health_days", "user_id");
  pgm.dropColumn("syncs", "user_id");
  pgm.dropTable("invites");
  pgm.dropTable("password_resets");
  pgm.dropTable("refresh_tokens");
  pgm.dropTable("users");
};
