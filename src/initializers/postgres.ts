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

export const query = async (text: string, params?: any[]) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  //   console.log("Executed query", { text, duration, rows: res.rowCount });
  return res;
};

export { pool };
