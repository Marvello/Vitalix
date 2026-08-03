const git = {
  hash: process.env.BUILD_VERSION || "dev",
  date: process.env.BUILD_DATE || new Date().toISOString().split("T")[0],
};

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  port: Number(process.env.PORT || 3000),
  isProd: process.env.NODE_ENV === "production",
  jwtSecret: process.env.JWT_SECRET,
  accessTtl: process.env.ACCESS_TTL || "15m",
  refreshTtl: process.env.REFRESH_TTL || "30d",
  resetTtlMs: Number(process.env.RESET_TTL_MS || 60 * 60 * 1000),
  inviteTtlMs: Number(process.env.INVITE_TTL_MS || 7 * 24 * 60 * 60 * 1000),
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),
  mailFrom: process.env.MAIL_FROM || "Vitalix <no-reply@vitalix.local>",
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:3000",
  smtp: process.env.SMTP_HOST
    ? {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      }
    : null,
  zealotEndpoint: process.env.ZEALOT_ENDPOINT || null,
  zealotToken: process.env.ZEALOT_TOKEN || null,
  zealotChannelKey: process.env.ZEALOT_CHANNEL_KEY || null,
};

config.buildVersion = git.hash;
config.buildDate = git.date;

if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
if (!config.jwtSecret) throw new Error("JWT_SECRET is required");
