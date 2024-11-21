import { pool } from "../initalizers/postgres";
import pg from "pg";
// Simplified query execution function
export const executeQuery = async <T>(
  queryFn: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    return await queryFn(client);
  } finally {
    client.release();
  }
};

// Add error boundary wrapper for queue operations
export async function safeQueueOperation<T>(
  operation: () => Promise<T>
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    console.error("Queue operation failed:", error);
    return null;
  }
}
