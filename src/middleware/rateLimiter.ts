import { Request, Response, NextFunction } from "express";
import { redis } from "../initalizers/redis";
import privy from "../initalizers/privy";
import { pool } from "../initalizers/postgres";
import express from "express";

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  errorMessage: string;
}

const TEN_YEARS_IN_MS = 365 * 24 * 60 * 60 * 1000 * 10;

// Modify the createRateLimiter to handle both authenticated and unauthenticated cases
export const createRateLimiter = (
  options: RateLimitOptions,
  isUnauthenticatedLimiter = false
): express.RequestHandler => {
  return async (req: any, res: Response, next: NextFunction) => {
    try {
      const ip = getClientIP(req);
      const key = `rate-limit:${ip}`;
      const currentCount = await redis.get(key);

      if (!currentCount) {
        await redis.setEx(key, Math.floor(options.windowMs / 1000), "1");
        return next();
      }

      const count = parseInt(currentCount);

      if (count >= options.maxRequests) {
        const ttl = await redis.ttl(key);
        return res.status(429).json({
          error: options.errorMessage,
          message: `Please try again in ${Math.ceil(ttl)} seconds.`,
          retryAfter: ttl,
        });
      }

      await redis.incr(key);
      next();
    } catch (error) {
      console.error("Rate limiter error:", error);
      next();
    }
  };
};

// Create the limiters
export const unauthenticatedConversationLimiter = createRateLimiter(
  {
    windowMs: TEN_YEARS_IN_MS,
    maxRequests: 3,
    errorMessage:
      "You have reached the maximum number of free requests. Please sign in to continue using the service.",
  },
  true
);

export const conversationLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 6,
  errorMessage: "Too many requests, please try again later.",
});

export const authAndRateLimit = async (
  req: any,
  res: any,
  next: any,
  user: any
) => {
  try {
    if (!user) {
      return unauthenticatedConversationLimiter(req, res, next);
    }
    return conversationLimiter(req, res, next);
  } catch (error) {
    console.error("Auth error:", error);
    return unauthenticatedConversationLimiter(req, res, next);
  }
};

// Helper function to get client IP
const getClientIP = (req: Request): string => {
  let ip =
    (Array.isArray(req.headers["x-forwarded-for"])
      ? req.headers["x-forwarded-for"][0]
      : req.headers["x-forwarded-for"]?.split(",")[0]) ||
    req.socket.remoteAddress ||
    req.ip ||
    "anonymous";

  // Normalize IP address
  if (ip === "::1" || ip === "::ffff:127.0.0.1") {
    ip = "127.0.0.1";
  }

  return ip.replace(/^::ffff:/, "");
};
