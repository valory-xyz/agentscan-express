import express from "express";
import { db } from "../../initalizers/postgres";
import privy from "../../initalizers/privy";
import { redis } from "../../initalizers/redis";
import dotenv from "dotenv";
import { eq, sql } from "drizzle-orm";
import { users } from "../../db/migrations/schema";

dotenv.config();

const router = express.Router();

// Function to generate a unique username
async function generateUniqueUsername(baseUsername: string): Promise<string> {
  let username = baseUsername;
  let isUnique = false;
  let attempts = 0;

  while (!isUnique && attempts < 10) {
    const result = await db
      .select()
      .from(users)
      .where(eq(users.username, username));

    if (result.length === 0) {
      isUnique = true;
    } else {
      // Append random letters and numbers
      const randomString = Math.random().toString(36).substring(2, 7);
      username = `${baseUsername}-${randomString}`;
      attempts++;
    }
  }

  if (!isUnique) {
    throw new Error("Unable to generate a unique username");
  }

  return username;
}

router.post("/", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // Verify the token using Privy
    const verifiedClaims = await privy.verifyAuthToken(token);

    const privy_did = verifiedClaims.userId;

    // Check if user is in Redis cache
    const cachedUser = await redis.get(`user:${privy_did}`);
    if (cachedUser) {
      return res.json(JSON.parse(cachedUser));
    }

    // Check if the user exists in our database using the privy_did column
    const userResult = await db
      .select()
      .from(users)
      .where(eq(users.privy_did, privy_did));
    console.log("result", userResult);

    let user: any;

    if (userResult.length === 0) {
      // User doesn't exist, fetch additional information from Privy
      const privyUser = await privy.getUser(verifiedClaims.userId);

      const wallet_address = privyUser.wallet?.address.toLowerCase() ?? null;
      const email = privyUser.email?.address;

      //check if farcaster
      let baseUsername = privyUser?.farcaster
        ? privyUser.farcaster?.username ?? privyUser.farcaster?.displayName
        : null;
      const pfp = privyUser?.farcaster?.pfp ?? null;
      const bio = privyUser?.farcaster?.bio ?? null;
      const fid = privyUser?.farcaster?.fid ?? null;

      const eth_wallets =
        privyUser.linkedAccounts
          .filter(
            (account: any) =>
              account.type === "wallet" && account.chainType === "ethereum"
          )
          .map((account: any) => account.address) || [];

      // Generate a random username if not provided
      if (!baseUsername) {
        const adjectives = [
          "happy",
          "sad",
          "angry",
          "sleepy",
          "hungry",
          "thirsty",
          "bored",
          "excited",
          "tired",
        ];
        const nouns = [
          "dog",
          "cat",
          "bird",
          "fish",
          "rabbit",
          "hamster",
          "horse",
          "turtle",
          "snake",
          "lizard",
        ];

        const randomAdjective =
          adjectives[Math.floor(Math.random() * adjectives.length)];
        const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
        baseUsername = `${randomAdjective}-${randomNoun}`;
      }

      // Generate a unique username
      const username = await generateUniqueUsername(baseUsername);

      // Insert new user into the database
      try {
        const newUserResult = await db
          .insert(users)
          .values({
            privy_did,
            username,
            email,
            eth_wallets,
            pfp,
            bio,
            fid,
            wallet_address,
          })
          .returning();

        if (newUserResult.length === 0) {
          return res.status(500).json({ message: "Failed to create user" });
        }
        user = newUserResult[0];
      } catch (err: any) {
        if (err.code === "23505" && err.constraint === "users_privy_did_key") {
          // Handle unique constraint violation for privy_did
          const existingUserResult = await db
            .select()
            .from(users)
            .where(eq(users.privy_did, privy_did));

          if (existingUserResult.length > 0) {
            user = existingUserResult[0];
          } else {
            return res.status(500).json({
              message:
                "Unexpected error: User not found after constraint violation.",
            });
          }
        } else {
          console.error("Error inserting user:", err);
          return res.status(500).json({ message: "Error creating user." });
        }
      }
    } else {
      user = userResult[0];

      //check if wallet_address is null and update it
      if (!user.wallet_address) {
        const privyUser = await privy.getUser(privy_did);
        const wallet_address = privyUser.wallet?.address.toLowerCase() ?? null;
        if (wallet_address) {
          const updatedUserResult = await db
            .update(users)
            .set({ wallet_address })
            .where(eq(users.privy_did, privy_did))
            .returning();

          if (updatedUserResult.length === 0) {
            return res.status(500).json({ message: "Failed to update user" });
          }
          user = updatedUserResult[0];
          // Clear the user cache
          redis.del(`user:${privy_did}`);
          redis.del(`user:${user.id}`);
        }
      }
    }

    // Cache the user in Redis
    await redis.set(`user:${privy_did}`, JSON.stringify(user), { EX: 60 * 60 }); // one hour
    await redis.set(`user:${user.id}`, JSON.stringify(user), { EX: 60 * 60 }); // one hour
    res.json(user);
  } catch (error) {
    console.error("Error in /signin:", error);
    res.status(401).json({ message: "Invalid token" });
  }
});

export default router;
