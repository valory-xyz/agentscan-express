import dotenv from "dotenv";

// Load environment variables from a .env file if it exists
dotenv.config();

const isLocalDev = process.env.USE_LOCAL_DB === "true";

export const config = {
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
    url: process.env.REDIS_URL,
  },
  olasPostgres: {
    user: process.env.OLAS_DB_USER,
    password: process.env.OLAS_DB_PASSWORD,
    host: process.env.OLAS_DB_HOST,
    port: parseInt(process.env.OLAS_DB_PORT || "5432", 10),
    database: process.env.OLAS_DB_NAME,
    ssl:
      process.env.OLAS_DB_SSL === "true"
        ? { rejectUnauthorized: false }
        : undefined,
  },
  postgres: {
    user: isLocalDev
      ? process.env.LOCAL_POSTGRES_USER
      : process.env.POSTGRES_USER || "postgres",
    host: isLocalDev
      ? process.env.LOCAL_POSTGRES_HOST
      : process.env.POSTGRES_HOST || "127.0.0.1",
    database: isLocalDev
      ? process.env.LOCAL_POSTGRES_DB
      : process.env.POSTGRES_DB || "postgres",
    password: isLocalDev
      ? process.env.LOCAL_POSTGRES_PASSWORD
      : process.env.POSTGRES_PASSWORD || "postgres",
    port: isLocalDev
      ? parseInt(process.env.LOCAL_POSTGRES_PORT || "54322", 10)
      : parseInt(process.env.POSTGRES_PORT || "54322", 10),
    ssl: isLocalDev
      ? undefined
      : process.env.POSTGRES_SSL === "true"
        ? { rejectUnauthorized: false }
        : undefined,
  },
  server: {
    port: parseInt(process.env.PORT || "4000", 10),
  },
  chat: {
    streamKey: process.env.CHAT_STREAM_KEY || "chat_messages",
    groupName: process.env.CHAT_GROUP_NAME || "chat_group",
    consumerPrefix: process.env.CHAT_CONSUMER_PREFIX || "consumer",
  },
};
