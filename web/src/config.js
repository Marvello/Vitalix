export const config = {
  databaseUrl: process.env.DATABASE_URL,
  authToken: process.env.AUTH_TOKEN || null,
  port: Number(process.env.PORT || 3000),
};

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL is required");
}
