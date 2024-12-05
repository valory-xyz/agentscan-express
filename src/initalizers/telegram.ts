import { Telegraf } from "telegraf";
import dotenv from "dotenv";
import { handleTelegramMessage } from "../services/telegram";

dotenv.config();

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required in environment variables");
}

export const telegramClient = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Error handling
telegramClient.catch((error) => {
  console.error("Telegram client error:", error);
});

// Initialize Telegram client
export const initializeTelegram = async (): Promise<void> => {
  try {
    // Initialize bot handlers
    telegramClient.on("message", handleTelegramMessage);
    console.log("Telegram bot initialized");

    await telegramClient.launch();

    // Enable graceful stop
    process.once("SIGINT", () => telegramClient.stop("SIGINT"));
    process.once("SIGTERM", () => telegramClient.stop("SIGTERM"));
  } catch (error) {
    console.error("Failed to initialize Telegram bot:", error);
  }
};
