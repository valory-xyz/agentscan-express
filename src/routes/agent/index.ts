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
import { generateEmbeddingWithRetry } from "../../services/openai";

const router = Router();

router.get("/", async (req, res) => {
  const agentId = req.query.id;

  if (!agentId) {
    return res.status(400).json({ message: "Agent ID." });
  }

  //get agent from db
  const agentQuery = await pool.query("SELECT * FROM agent WHERE id = $1", [
    agentId,
  ]);

  if (agentQuery.rows.length === 0) {
    return res.status(404).json({ message: "Agent not found." });
  }

  res.status(200).json(agentQuery.rows[0]);
});

export default router;
