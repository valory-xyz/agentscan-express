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

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const TIMEOUT_MS = 25000; // 25 seconds

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> => {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Operation timed out")), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]);
};

export const initializeTelegram = async (
  retryCount = 0,
  delay = INITIAL_RETRY_DELAY
): Promise<void> => {
  try {
    telegramClient.on("message", handleTelegramMessage);
    console.log("Telegram bot initialized");

    await withTimeout(telegramClient.launch(), TIMEOUT_MS);

    process.once("SIGINT", () => telegramClient.stop("SIGINT"));
    process.once("SIGTERM", () => telegramClient.stop("SIGTERM"));
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(
      `Failed to initialize Telegram bot (attempt ${
        retryCount + 1
      }): ${errorMessage}`
    );

    if (retryCount < MAX_RETRIES) {
      console.log(`Retrying in ${delay / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return initializeTelegram(retryCount + 1, delay * 2);
    } else {
      console.error(
        `Failed to initialize Telegram bot after ${MAX_RETRIES} attempts`
      );
    }
  }
};
