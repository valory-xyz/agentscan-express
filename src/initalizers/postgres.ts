import { Pool } from "pg";
import { config } from "../config";

const pool = new Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  user: config.postgres.user,
  password: config.postgres.password,
  database: config.postgres.database,
  ssl: config.postgres.ssl,
});

const olasPool = new Pool({
  host: config.olasPostgres.host,
  port: config.olasPostgres.port,
  user: config.olasPostgres.user,
  password: config.olasPostgres.password,
  database: config.olasPostgres.database,
  ssl: config.olasPostgres.ssl,
});

// Test both connections
(async () => {
  const client = await pool.connect();
  const olasClient = await olasPool.connect();
  try {
    console.log("Connected to the main database");
    console.log("Connected to the OLAS database");
  } catch (err) {
    console.error("Error executing test query:", err);
  } finally {
    client.release();
    olasClient.release();
  }
})().catch((err) => console.error("Error connecting to the databases", err));

export { pool, olasPool };
