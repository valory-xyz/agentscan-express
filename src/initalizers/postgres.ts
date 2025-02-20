import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config";
import * as schema from "../db/migrations/schema";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Create the main connection pool
const pool = new Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  user: config.postgres.user,
  password: config.postgres.password,
  database: config.postgres.database,
  ssl: config.postgres.ssl,
});

// Create the OLAS connection pool
const olasPool = new Pool({
  host: config.olasPostgres.host,
  port: config.olasPostgres.port,
  user: config.olasPostgres.user,
  password: config.olasPostgres.password,
  database: config.olasPostgres.database,
  ssl: config.olasPostgres.ssl,
});

// Initialize Drizzle with the main pool and schema
const db = drizzle(pool, { schema });

// Initialize Drizzle with the OLAS pool and schema
const olasDb = drizzle(olasPool, { schema });

// Test both connections
(async () => {
  try {
    // Test main database connection
    await pool.connect();
    console.log("Connected to the main database");

    // Test OLAS database connection
    await olasPool.connect();
    console.log("Connected to the OLAS database");
  } catch (err) {
    console.error("Error connecting to the databases:", err);
  }
})().catch((err) => console.error("Error in database initialization:", err));

export { db, olasDb, pool, olasPool };
