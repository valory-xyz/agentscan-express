import { Pool } from "pg";
import { config } from "../config";

const pool = new Pool({
  connectionString: config.postgres.url,
});

(async () => {
  const client = await pool.connect();
  console.log("Connected to the database");
  client.release();
})().catch((err) => console.error("Error connecting to the database", err));

export { pool };
