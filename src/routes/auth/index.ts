import express from "express";
import { pool } from "../../initalizers/postgres";
import privy from "../../initalizers/privy";
import { redis } from "../../initalizers/redis";
import dotenv from "dotenv";

dotenv.config();

const router = express.Router();

// Function to generate a unique username
async function generateUniqueUsername(baseUsername: any) {
  let username = baseUsername;
  let isUnique = false;
  let attempts = 0;

  while (!isUnique && attempts < 10) {
    const result = await pool.query(
      "SELECT username FROM users WHERE username = $1",
      [username]
    );

    if (result.rows.length === 0) {
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

router.post("/signin", async (req, res) => {
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
    const userResult = await pool.query(
      "SELECT * FROM users WHERE privy_did = $1",
      [privy_did]
    );

    let user: any;

    if (userResult.rows.length === 0) {
      // User doesn't exist, fetch additional information from Privy
      const privyUser = await privy.getUser(privy_did);
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

      const sol_wallets =
        privyUser.linkedAccounts
          .filter(
            (account: any) =>
              account.type === "wallet" && account.chainType === "solana"
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
        const newUserResult = await pool.query(
          `INSERT INTO users (id, privy_did, username, email, eth_wallets, sol_wallets, pfp, bio, fid,wallet_address) 
      VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7, $8, $9) 
      RETURNING *`,
          [
            privy_did,
            username,
            email,
            eth_wallets,
            sol_wallets,
            pfp,
            bio,
            fid,
            wallet_address,
          ]
        );

        if (newUserResult.rows.length === 0) {
          return res.status(500).json({ message: "Failed to create user" });
        }
        user = newUserResult.rows[0];
      } catch (err: any) {
        if (err.code === "23505" && err.constraint === "users_privy_did_key") {
          // Handle unique constraint violation for privy_did
          const existingUserResult = await pool.query(
            "SELECT * FROM users WHERE privy_did = $1",
            [privy_did]
          );

          if (existingUserResult.rows.length > 0) {
            user = existingUserResult.rows[0];
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
      user = userResult.rows[0];

      //check if wallet_address is null and update it
      if (!user.wallet_address) {
        const privyUser = await privy.getUser(privy_did);
        const wallet_address = privyUser.wallet?.address.toLowerCase() ?? null;
        if (wallet_address) {
          const updatedUserResult = await pool.query(
            `UPDATE users SET wallet_address = $1 WHERE privy_did = $2 RETURNING *`,
            [wallet_address, privy_did]
          );
          if (updatedUserResult.rows.length === 0) {
            //log
            console.log("Error updating user wallet address");
          }
          user = updatedUserResult.rows[0];
          // Clear the user cache
          redis.del(`user:${privy_did}`);
          redis.del(`user:${user.id}`);
        }
      }
    }

    // Cache the user in Redis
    await redis.set(`user:${privy_did}`, JSON.stringify(user), { EX: 60 * 60 }); // one hour

    res.json(user);
  } catch (error) {
    console.error("Error in /signin:", error);
    res.status(401).json({ message: "Invalid token" });
  }
});

export default router;
