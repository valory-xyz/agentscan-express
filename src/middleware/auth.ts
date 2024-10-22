import { Request, Response, NextFunction } from "express";
import { pool } from "../initalizers/postgres";
import { redis } from "../initalizers/redis";
import dotenv from "dotenv";
dotenv.config();
import privy from "../initalizers/privy";

const CACHE_DURATION = 1800; // 30 minutes in seconds

export async function authMiddleware(
  req: any,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const verifiedClaims = await privy.verifyAuthToken(token);
    const userId = verifiedClaims.userId;

    // Check if user is in Redis cache
    const cachedUser = await redis.get(`user:${userId}`);
    if (cachedUser) {
      req.user = JSON.parse(cachedUser);
      return next();
    }

    // Check if the user exists in our database
    const userResult = await pool.query(
      "SELECT * FROM users WHERE privy_did = $1",
      [userId]
    );

    let user;

    if (userResult.rows.length === 0) {
      //return unauthorized if user does not exist
      return res.status(401).json({ message: "Invalid token" });
    } else {
      user = userResult.rows[0];
    }

    // Cache the user in Redis
    await redis.set(`user:${userId}`, JSON.stringify(user), {
      EX: CACHE_DURATION,
    });

    // Attach the user to the request object
    req.user = user;

    next();
  } catch (error) {
    console.log("Error in auth middleware:", error);
    if (error instanceof Error && error.name === "PrivyValidationError") {
      console.log("Invalid token Privy");
      return res.status(401).json({ message: "Invalid token Privy" });
    }
    res.status(500).json({ message: "Internal server error" });
  }
}
