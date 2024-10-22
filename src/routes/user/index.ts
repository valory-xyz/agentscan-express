import { Router } from "express";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { user_cache_key } from "../../services/user";
import { redis } from "../../initalizers/redis";
import { pool } from "../../initalizers/postgres";

const router = Router();

// Configure S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

// Configure multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Route to update user profile
router.put("/", upload.single("pfp"), async (req: any, res) => {
  const userId = req.user?.id; // Retrieve user ID from authenticated request
  let { username, bio } = req.body;
  const file = req.file;

  if (!userId || !username) {
    return res
      .status(400)
      .json({ message: "User ID and new username are required." });
  }

  if (username.length > 40) {
    return res
      .status(400)
      .json({ message: "Username must be 40 characters or less." });
  }

  if (bio && bio.length > 160) {
    return res
      .status(400)
      .json({ message: "Bio must be 160 characters or less." });
  }

  try {
    // First, retrieve the current user data
    const getCurrentUserQuery = "SELECT pfp FROM users WHERE id = $1";
    const currentUser = await pool.query(getCurrentUserQuery, [userId]);

    if (currentUser.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    let pfpUrl = currentUser.rows[0].pfp;

    // If a new file is uploaded, process it
    if (file) {
      // Delete the old profile picture from S3 if it exists
      if (pfpUrl) {
        const oldKey = pfpUrl.split("/").pop();
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: oldKey,
          })
        );
      }

      // Upload new file to S3
      const fileKey = `profile-pictures/${uuidv4()}-${file.originalname}`;
      await s3Client.send(
        new PutObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: fileKey,
          Body: file.buffer,
          ContentType: file.mimetype,
        })
      );

      pfpUrl = `https://${process.env.S3_BUCKET_NAME}.s3.amazonaws.com/${fileKey}`;
    }

    // Update user in database
    const updateUserQuery = `
      UPDATE users 
      SET username = $1, pfp = $2, bio = $3 
      WHERE id = $4 
      RETURNING *;
    `;
    const result = await pool.query(updateUserQuery, [
      username,
      pfpUrl,
      bio,
      userId,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    // Clear user cache to reflect the update
    await redis.del(user_cache_key(userId.toString()));
    await redis.del(user_cache_key(result.rows[0].privy_did));

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating user profile:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Route to update display name for a user in a server
router.put("/servers/:serverId/edit-display-name", async (req: any, res) => {
  const userId = req.user?.id; // Retrieve user ID from authenticated request
  const { serverId } = req.params;
  const { display_name } = req.body;

  if (!userId || !serverId) {
    return res
      .status(400)
      .json({ message: "Server ID and display name are required." });
  }

  try {
    const query = `UPDATE server_members SET display_name = $1 WHERE user_id = $2 AND server_id = $3 RETURNING *`;
    const result = await pool.query(query, [display_name, userId, serverId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User or server not found." });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating display name:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
