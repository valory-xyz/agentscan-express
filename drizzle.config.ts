import type { Config } from "drizzle-kit";
import { config } from "./src/config";

export default {
  schema: "./src/db/migrations/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",

  introspect: {
    casing: "preserve",
  },
  dbCredentials: {
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
