import express from "express";
import { createServer } from "http";
import { config } from "./config";
import cors from "cors";
import dotenv from "dotenv";
import { initializeDiscord } from "./initalizers/discord";
import { initializeTelegram } from "./initalizers/telegram";

dotenv.config();

const app = express();
const httpServer = createServer(app);

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

app.use(cors());

app.use("/", require("./routes").default);

async function initServer(): Promise<void> {
  // Check for OLAS_SCHEMA_ID
  if (!process.env.OLAS_SCHEMA_ID) {
    throw new Error('OLAS_SCHEMA_ID environment variable is not set');
  }

  httpServer.listen(config.server.port, () => {
    console.log(`Server running on port ${config.server.port}`);
  });
  await initializeDiscord();

  try {
    await initializeTelegram();
    console.log("Telegram initialization completed successfully");
  } catch (error) {
    console.error("Failed to initialize Telegram:", error);
  }
}

initServer().catch(console.error);
