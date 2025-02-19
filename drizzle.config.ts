import type { Config } from "drizzle-kit";
import { config } from "./src/config";

const isLocalDev =
  process.env.NODE_ENV === "development" && process.env.USE_LOCAL_DB === "true";

export default {
  schema: "./src/db/migrations/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",

  introspect: {
    casing: "preserve",
  },
  dbCredentials: isLocalDev
    ? {
        host: process.env.LOCAL_POSTGRES_HOST || "localhost",
        port: Number(process.env.LOCAL_POSTGRES_PORT) || 5432,
        user: process.env.LOCAL_POSTGRES_USER,
        password: process.env.LOCAL_POSTGRES_PASSWORD,
        database: process.env.LOCAL_POSTGRES_DB || "agentscan_local",
        ssl: false,
      }
    : {
        host: config.postgres.host,
        port: config.postgres.port,
        user: config.postgres.user,
        password: config.postgres.password,
        database: config.postgres.database,
        ssl: config.postgres.ssl,
      },
  verbose: true,
  strict: true,
} satisfies Config;
