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

const router = Router();
const CACHE_TTL = 3 * 60 * 60;
const TEAM_CACHE_TTL = 30 * 60;

// Add this helper function before the router.post
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

router.post("/", async (req: any, res) => {
  const question = req.body.question;
  const messages = req.body.messages;
  const user = req.user;
  const teamId = req.body.teamId as string;

  if (!question) {
    return res.status(400).json({ message: "question is required." });
  }

  const decodedQuestion = decodeURIComponent(question as string);

  // Generate cache key using deployment ID and request parameters
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID || "local";
  const cacheKey = `conversation:${deploymentId}:${teamId}:${Buffer.from(
    decodedQuestion
  ).toString("base64")}`;

  // Create team cache key
  const teamCacheKey = `team:${teamId}`;

  // Try to get team from cache first
  let teamData;
  try {
    const cachedTeam = await redis.get(teamCacheKey);
    if (cachedTeam) {
      teamData = JSON.parse(cachedTeam);
    } else {
      const teamQuery = await pool.query(
        "SELECT * FROM teams WHERE id = $1 AND deleted_at IS NULL",
        [teamId]
      );

      if (teamQuery.rows.length === 0) {
        return res.status(404).json({ message: "Team not found" });
      }

      teamData = teamQuery.rows[0];

      // Cache the team data
      await redis.set(teamCacheKey, JSON.stringify(teamData), {
        EX: TEAM_CACHE_TTL,
      });
    }
  } catch (error) {
    console.error("Error with team cache:", error);
    // Fallback to direct database query if cache fails
    const teamQuery = await pool.query(
      "SELECT * FROM teams WHERE id = $1 AND deleted_at IS NULL",
      [teamId]
    );

    if (teamQuery.rows.length === 0) {
      return res.status(404).json({ message: "Team not found" });
    }

    teamData = teamQuery.rows[0];
  }

  const systemPromptName = teamData.system_prompt_name;
  const teamName = teamData.name;
  const userType = teamData.user_type;

  try {
    const amplitudeProperties = {
      team_id: teamId || "unknown",
      question: decodedQuestion,
      messages: messages,
    };

    const amplitudeOptions = {
      user_id: user?.privy_did || "unknown",
      user_properties: { is_anonymous: !user?.privy_did },
    };

    amplitudeClient.track(
      "conversation_made",
      amplitudeProperties,
      amplitudeOptions
    );
  } catch (error) {
    console.error("Error tracking conversation:", error);
  }

  // Check cache first
  try {
    const cachedResponse = await redis.get(cacheKey);
    if (cachedResponse) {
      console.log("Cache hit for question:", decodedQuestion);
      const chunks = JSON.parse(cachedResponse);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      await sleep(500);
      for (const chunk of chunks) {
        await sleep(70 + Math.random() * 50);
        res.write(`${JSON.stringify({ content: chunk })}\n\n`);
      }

      res.write(`${JSON.stringify({ done: true })}\n\n`);
      res.end();
      return;
    }
  } catch (cacheError) {
    console.error("Cache error:", cacheError);
    // Continue with normal flow if cache fails
  }

  const questionEmbedding = await generateEmbeddingWithRetry(decodedQuestion);

  const STAKING_PATTERNS = [
    "stake olas",
    "staking olas",
    "how to stake",
    "easiest way to stake",
    "run olas",
    "running olas",
    "how to run",
    "to run",
    "easiest way to run",
  ].map((pattern) => `%${pattern}%`);

  const codeEmbeddingsQuery = await pool.query(
    `SELECT 
      content,
      name,
      location,
      type,
      (embedding <=> $1) * 
      CASE 
        WHEN $2 = 'olas' AND LOWER($3) LIKE ANY(ARRAY[${STAKING_PATTERNS.map(
          (_, i) => `$${i + 4}`
        ).join(", ")}]) 
          AND LOWER(content) LIKE '%pearl%' THEN 0.3  -- Boost Pearl content highest
        WHEN $2 = 'olas' AND LOWER($3) LIKE ANY(ARRAY[${STAKING_PATTERNS.map(
          (_, i) => `$${i + 4}`
        ).join(", ")}]) THEN 0.5
        WHEN LOWER(content) LIKE $3 THEN 0.7
        WHEN LOWER(name) LIKE $3 THEN 0.8
        ELSE 1.0
      END as similarity
    FROM context_embeddings 
    WHERE company_id = $2
    ORDER BY similarity
    LIMIT 24`,
    [
      questionEmbedding,
      teamName,
      `%${decodedQuestion.toLowerCase()}%`,
      ...STAKING_PATTERNS,
    ]
  );

  const codeEmbeddings = codeEmbeddingsQuery.rows;

  //for each code embedding, ask if it is relevant to the question
  const filterPromises = codeEmbeddings.map((embedding, index) =>
    withRetry(
      async () => {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: `Given the following question: "${decodedQuestion}"
Rate how relevant this context is for answering the question on a scale of 0-10 
(0 being completely irrelevant, 10 being highly relevant).
Respond with only a number.

Context:
${embedding.content}
`,
            },
          ],
          max_tokens: 10,
          temperature: 0.1,
        });

        const score = parseInt(
          completion.choices[0].message.content?.trim() || "0"
        );

        // Throw error if response is not a number between 0-10
        if (isNaN(score) || score < 0 || score > 10) {
          throw new Error("Invalid score format");
        }

        return { score, index };
      },
      { maxRetries: 3, initialDelay: 1000 }
    )
  );

  const relevantEmbeddings = await Promise.all(filterPromises);
  console.log(
    "Relevance scores:",
    relevantEmbeddings.map((e) => `${e.index}:${e.score}`).join(", ")
  );

  // Sort by score and take top 30% or at least 3 results, whichever is greater
  const minResults = 6;
  const percentageToKeep = 0.35;

  const sortedEmbeddings = relevantEmbeddings.sort((a, b) => b.score - a.score);

  const numToKeep = Math.max(
    minResults,
    Math.ceil(sortedEmbeddings.length * percentageToKeep)
  );

  const relevantIndices = sortedEmbeddings
    .slice(0, numToKeep)
    .filter(({ score }) => score >= 4)
    .map(({ index }) => index);

  const relevantContext = codeEmbeddings
    .filter((_, index) => relevantIndices.includes(index))
    .map((embedding) => ({
      content: embedding.content,
      name: embedding.name,
      location: embedding.location || "",
      type: embedding.type || "component",
    }));

  //limit to 10 relevant context
  const limitedContext = relevantContext
    .sort((a: any, b: any) => b.similarity - a.similarity)
    .slice(0, 10);

  console.log(
    `Selected ${relevantIndices.length} relevant contexts after filtering`
  );

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const responseChunks: string[] = [];

  try {
    let chunkCount = 0;
    for await (const chunk of generateChatResponseWithRetry(
      limitedContext,
      messages,
      systemPromptName,
      userType
    )) {
      chunkCount++;
      responseChunks.push(chunk); // Store chunk for caching

      if (chunkCount % 50 === 0) {
        console.log(`Streamed ${chunkCount} chunks so far`);
      }

      try {
        // Add a small random delay between chunks (between 75-125ms)
        await sleep(70 + Math.random() * 50);

        res.write(`${JSON.stringify({ content: chunk })}\n\n`);
      } catch (writeError) {
        console.error("Error writing chunk:", writeError);
        throw writeError;
      }
    }

    // Cache the response after successful generation
    try {
      redis.set(cacheKey, JSON.stringify(responseChunks), {
        EX: CACHE_TTL,
      });
      console.log("Cached response for question:", decodedQuestion);
    } catch (cacheError) {
      console.error("Error caching response:", cacheError);
    }

    try {
      res.write(`${JSON.stringify({ done: true })}\n\n`);
      console.log("Wrote completion message");
    } catch (finalWriteError) {
      console.error("Error writing completion message:", finalWriteError);
      throw finalWriteError;
    }
  } catch (error) {
    console.error("Streaming error:", error);
    try {
      res.write(`${JSON.stringify({ error: "Streaming failed" })}\n\n`);
      console.log("Wrote error message");
    } catch (errorWriteError) {
      console.error("Error writing error message:", errorWriteError);
    }
  } finally {
    try {
      res.end();
      console.log("Response ended successfully");
    } catch (endError) {
      console.error("Error ending response:", endError);
    }
  }
});

export default router;
