import { Request, Response, NextFunction } from "express";
import { db, pool } from "../initalizers/postgres";
import { redis } from "../initalizers/redis";
import dotenv from "dotenv";
dotenv.config();
import privy from "../initalizers/privy";
import { users } from "../db/migrations/schema";
import { eq } from "drizzle-orm";

const CACHE_DURATION = 1800; // 30 minutes in seconds

export async function authMiddleware(
  req: any,
  res: Response,
  next: NextFunction,
  allowNoUser: boolean = false
) {
  const authHeader = req.headers.authorization;

  // If no auth header and allowNoUser is true, continue
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    if (allowNoUser) {
      console.log("No token provided, continuing with no user");
      req.user = null;
      return next();
    }
    return res.status(401).json({ message: "No token provided" });
  }

  try {
    const token = authHeader.split(" ")[1];

    // If invalid token format and allowNoUser is true, continue
    if (!token || token.trim() === "") {
      if (allowNoUser) {
        console.log("Invalid token format, continuing with no user");
        req.user = null;
        return next();
      }
      return res.status(401).json({ message: "Invalid token format" });
    }

    let verifiedClaims;
    try {
      verifiedClaims = await privy.verifyAuthToken(token);
    } catch (privyError) {
      console.log("Privy verification error:", privyError);
      if (allowNoUser) {
        console.log("Token verification failed, continuing with no user");
        req.user = null;
        return next();
      }
      return res.status(401).json({
        message: "Invalid authentication token",
        error:
          privyError instanceof Error ? privyError.message : "Unknown error",
      });
    }

    const userId = verifiedClaims.userId;

    // Check if user is in Redis cache
    const cachedUser = await redis.get(`user:${userId}`);
    if (cachedUser) {
      console.log("User found in cache", userId);
      req.user = JSON.parse(cachedUser);
      return next();
    }

    // Check if the user exists in our database
    const userResult = await db
      .select()
      .from(users)
      .where(eq(users.privy_did, userId));

    let user;

    if (userResult.length === 0) {
      if (allowNoUser) {
        req.user = null;
        return next();
      }
      console.log("User not found in database", userId);
      return res.status(401).json({ message: "Invalid token" });
    } else {
      user = userResult[0];
    }

    // Cache the user in Redis
    await redis.set(`user:${userId}`, JSON.stringify(user), {
      EX: CACHE_DURATION,
    });
    await redis.set(`user:${user.id}`, JSON.stringify(user), {
      EX: CACHE_DURATION,
    });
    console.log("Cached user in Redis", user.id);

    // Attach the user to the request object
    req.user = user;

    next();
  } catch (error) {
    console.log("Error in auth middleware:", error);
    if (error instanceof Error) {
      if (
        error.name === "PrivyValidationError" ||
        error.name === "JWSInvalid"
      ) {
        console.log("Invalid token:", error.message);
        return res.status(401).json({
          message: "Invalid authentication token",
          error: error.message,
        });
      }
    }
    return res.status(500).json({
      message: "Internal server error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
