import { Router } from "express";
import { user_cache_key } from "../../services/user";
import { redis } from "../../initalizers/redis";
import { pool } from "../../initalizers/postgres";

const router = Router();

// Route to update user profile
router.put("/", async (req: any, res) => {
  const userId = req.user?.id; // Retrieve user ID from authenticated request
  let { username, bio } = req.body;

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

    // Update user in database
    const updateUserQuery = `
      UPDATE users 
      SET username = $1, bio = $2 
      WHERE id = $3 
      RETURNING *;
    `;
    const result = await pool.query(updateUserQuery, [username, bio, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

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
