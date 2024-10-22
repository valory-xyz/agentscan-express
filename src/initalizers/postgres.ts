import { Pool } from "pg";
import { config } from "../config";

// PostgreSQL setup
const pool = new Pool(config.postgres);

//connect to the database

(async () => {
  const client = await pool.connect();
  console.log("Connected to the database");
  client.release();
})().catch((err) => console.error("Error connecting to the database", err));

export { pool };
