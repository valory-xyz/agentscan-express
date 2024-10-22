import { Channel } from "../types";
import { pool } from "../initalizers/postgres";
import { readMessages } from "./messages";

/**
 * Initializes a new Redis stream and sets up message reading for a new channel.
 * @param channelId - The ID of the new channel to initialize.
 */
export async function initializeNewChannel(channelId: string): Promise<void> {
  if (!channelId) {
    console.error("Channel ID is required.");
    return;
  }

  // Start reading messages from the stream for the new channel
  setInterval(() => readMessages(channelId), 100); // Poll every 100ms per channel
}

/**
 * Fetches all active channels from the database.
 * @returns {Promise<Channel[]>} - Returns a promise that resolves to an array of channels.
 */
export async function fetchAllChannels(): Promise<Channel[]> {
  const query = `SELECT * FROM channels`;

  try {
    const result = await pool.query(query);
    return result.rows;
  } catch (err) {
    console.error("Error fetching channels:", err);
    throw err;
  }
}

// Function to listen for PostgreSQL notifications
export async function listenForNewChannels() {
  const client = await pool.connect();

  // Listen to the 'new_channel' event
  await client.query('LISTEN "new_channel"');

  client.on("notification", async (msg) => {
    if (msg.channel === "new_channel") {
      const payload = JSON.parse(msg.payload || "{}");

      // Handle the new channel (e.g., initialize Redis stream)
      initializeNewChannel(payload.id);
    }
  });

  client.on("error", (err) => {
    console.error("Error in PostgreSQL client:", err);
  });
}

listenForNewChannels().catch((err) =>
  console.error("Error setting up channel listener:", err)
);
