import Redis from "ioredis";
import { config } from "../config";

const redis = new Redis(config.redis);

const STREAM_KEY = config.chat.streamKey;
const GROUP_NAME = config.chat.groupName;

/**
 * Creates a consumer group for a Redis stream if it doesn't exist.
 * This function uses the XGROUP CREATE command with the MKSTREAM option
 * to create the stream if it does not exist.
 *
 * @returns {Promise<void>} - A promise that resolves when the consumer group is created.
 */
async function createConsumerGroup(): Promise<void> {
  try {
    // Create the consumer group, and if the stream does not exist, create it with MKSTREAM
    await redis.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "0", "MKSTREAM");
    console.log(
      `Consumer group '${GROUP_NAME}' created for stream '${STREAM_KEY}'.`
    );
  } catch (err: any) {
    // Check if the error is 'BUSYGROUP Consumer Group name already exists'
    if (err.message.includes("BUSYGROUP Consumer Group name already exists")) {
      console.log(
        `Consumer group '${GROUP_NAME}' already exists for stream '${STREAM_KEY}'.`
      );
    } else {
      // console.error("Error creating consumer group:", err);
      throw err; // Re-throw the error after logging it
    }
  }
}

export { createConsumerGroup };
