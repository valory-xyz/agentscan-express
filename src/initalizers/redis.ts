import { createClient } from "redis";
import { config } from "../config";

// Create a Redis client instance
const redis = createClient({
  url: config.redis.url,
});

redis.on("error", (err) => {
  console.error("Redis Client Error:", err);
});

// Connect to Redis
async function connectRedis() {
  try {
    await redis.connect();
    console.log("Connected to Redis successfully");
  } catch (err) {
    console.error("Error connecting to Redis:", err);
  }
}

connectRedis();

export { redis };
