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
const TIMEOUT_MS = 30000; // 30 seconds

// Add error type handling
interface TelegramError extends Error {
  code?: number;
  description?: string;
}

const handleTelegramError = (
  error: TelegramError,
  retryCount: number
): boolean => {
  if (error.code === 409) {
    console.warn(
      `Telegram conflict error (409) on attempt ${retryCount + 1}: ${
        error.description
      }`
    );

    return true; // Indicate that we should retry
  }

  return false; // Don't retry for other errors
};

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

    await withTimeout(
      (async () => {
        await telegramClient.launch();
        console.log("Telegram bot successfully initialized!");
      })(),
      TIMEOUT_MS
    );

    process.once("SIGINT", () => telegramClient.stop("SIGINT"));
    process.once("SIGTERM", () => telegramClient.stop("SIGTERM"));
  } catch (error) {
    const telegramError = error as TelegramError;
    const errorMessage =
      telegramError.description || telegramError.message || "Unknown error";
    console.error(
      `Failed to initialize Telegram bot (attempt ${
        retryCount + 1
      }): ${errorMessage}`
    );

    const shouldRetry = handleTelegramError(telegramError, retryCount);

    if (shouldRetry && retryCount < MAX_RETRIES) {
      // For 409 errors, use a longer delay to allow previous operation to complete
      const retryDelay = telegramError.code === 409 ? delay * 2 : delay;
      console.log(`Retrying in ${retryDelay / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      return initializeTelegram(retryCount + 1, retryDelay);
    } else if (retryCount >= MAX_RETRIES) {
      console.error(
        `Failed to initialize Telegram bot after ${MAX_RETRIES} attempts`
      );
      throw error;
    } else {
      throw error; // Rethrow non-retryable errors
    }
  }
};
