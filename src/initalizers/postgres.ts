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

(async () => {
  const client = await pool.connect();
  try {
    console.log("Connected to the database");
  } catch (err) {
    console.error("Error executing test query:", err);
  } finally {
    client.release();
  }
})().catch((err) => console.error("Error connecting to the database", err));

export { pool };
