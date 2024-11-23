import { Request, Response, NextFunction } from "express";
import { redis } from "../initalizers/redis";

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  errorMessage: string;
}

export const createRateLimiter = (options: RateLimitOptions) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Get client IP
      const ip = getClientIP(req);
      const key = `rate-limit:${ip}`;

      // Get current count from Redis
      const currentCount = await redis.get(key);

      if (!currentCount) {
        // First request, set initial count
        await redis.setEx(key, Math.floor(options.windowMs / 1000), "1");
        return next();
      }

      const count = parseInt(currentCount);

      if (count >= options.maxRequests) {
        // Get TTL for the key
        const ttl = await redis.ttl(key);

        return res.status(429).json({
          error: options.errorMessage,
          message: `Please try again in ${Math.ceil(ttl)} seconds.`,
          retryAfter: ttl,
        });
      }

      // Increment count
      await redis.incr(key);
      next();
    } catch (error) {
      console.error("Rate limiter error:", error);
      // If rate limiting fails, allow the request to proceed
      next();
    }
  };
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

// Usage example
export const conversationLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 6, // 6 requests per minute
  errorMessage: "Too many requests, please try again later.",
});
