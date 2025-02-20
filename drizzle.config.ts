import type { Config } from "drizzle-kit";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config({
  path: process.env.NODE_ENV === "production" ? ".env.production" : ".env",
});

export const isLocalDev = process.env.USE_LOCAL_DB === "true";

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
        user: process.env.LOCAL_POSTGRES_USER || "postgres",
        password: process.env.LOCAL_POSTGRES_PASSWORD || "",
        database: process.env.LOCAL_POSTGRES_DB || "agentscan_local",
        ssl: false,
      }
    : {
        host: process.env.POSTGRES_HOST || "localhost",
        port: Number(process.env.POSTGRES_PORT) || 5432,
        user: process.env.POSTGRES_USER || "postgres",
        password: process.env.POSTGRES_PASSWORD || "postgres",
        database: process.env.POSTGRES_DB || "postgres",
        ssl: {
          rejectUnauthorized: false,
        },
      },
  verbose: true,
  strict: true,
} satisfies Config;
