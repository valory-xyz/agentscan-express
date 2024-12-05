import e, { Router } from "express";
import { pool } from "../../initalizers/postgres";
import {
  generateChatResponseWithRetry,
  generateEmbeddingWithRetry,
} from "../../services/openai";
import { withRetry } from "../../services/crawler";
import openai from "../../initalizers/openai";

import { amplitudeClient } from "../../initalizers/amplitude";
import { redis } from "../../initalizers/redis";
import {
  getTeamData,
  findRelevantContext,
  generateConversationResponse,
} from "../../services/conversation";

const router = Router();
const CACHE_TTL = 3 * 60 * 60;
const TEAM_CACHE_TTL = 30 * 60;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

router.post("/", async (req: any, res) => {
  const { question, messages, teamId } = req.body;

  if (!question) {
    return res.status(400).json({ message: "question is required." });
  }

  try {
    const teamData = await getTeamData(teamId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    for await (const response of generateConversationResponse(
      question,
      messages,
      teamData
    )) {
      res.write(`${JSON.stringify(response)}\n\n`);

      if (response.error) {
        break;
      }
    }

    res.end();
  } catch (error: any) {
    if (error.message === "Team not found") {
      return res.status(404).json({ message: "Team not found" });
    }
    console.error("Error processing request:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
