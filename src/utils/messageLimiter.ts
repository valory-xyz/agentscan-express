import { redis } from "../initalizers/redis";

const TEN_YEARS_IN_MS = 365 * 24 * 60 * 60 * 1000 * 10;

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export const DEFAULT_LIMITS = {
  authenticated: {
    windowMs: 60 * 1000,
    maxRequests: 6,
  },
  unauthenticated: {
    windowMs: TEN_YEARS_IN_MS,
    maxRequests: 5,
  },
};

export async function checkRateLimit(
  userId: string,
  isAuthenticated: boolean,
  config: RateLimitConfig = isAuthenticated
    ? DEFAULT_LIMITS.authenticated
    : DEFAULT_LIMITS.unauthenticated
): Promise<{ limited: boolean; ttl?: number }> {
  const key = `rate-limit:${userId}`;
  const currentCount = await redis.get(key);

  if (!currentCount) {
    await redis.setEx(key, Math.floor(config.windowMs / 1000), "1");
    return { limited: false };
  }

  const count = parseInt(currentCount);
  if (count >= config.maxRequests) {
    const ttl = await redis.ttl(key);
    return { limited: true, ttl };
  }

  await redis.incr(key);
  return { limited: false };
}
