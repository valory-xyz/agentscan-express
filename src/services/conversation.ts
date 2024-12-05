import { pool } from "../initalizers/postgres";
import { redis } from "../initalizers/redis";
import openai from "../initalizers/openai";
import {
  generateChatResponseWithRetry,
  generateEmbeddingWithRetry,
} from "./openai";
import { withRetry } from "./crawler";

const TEAM_CACHE_TTL = 30 * 60;

interface TeamData {
  system_prompt_name: string;
  name: string;
  user_type: string;
  [key: string]: any;
}

interface RelevantContext {
  content: string;
  name: string;
  location: string;
  type: string;
  similarity?: number;
}

interface ChatResponse {
  content: string;
  done?: boolean;
  error?: string;
}

export async function getTeamData(teamId: string): Promise<TeamData> {
  const teamCacheKey = `team:${teamId}`;

  try {
    const cachedTeam = await redis.get(teamCacheKey);
    if (cachedTeam) {
      return JSON.parse(cachedTeam);
    }

    const teamData = await fetchTeamFromDB(teamId);
    await redis.set(teamCacheKey, JSON.stringify(teamData), {
      EX: TEAM_CACHE_TTL,
    });

    return teamData;
  } catch (error) {
    console.error("Error with team cache:", error);
    return await fetchTeamFromDB(teamId);
  }
}

async function fetchTeamFromDB(teamId: string): Promise<TeamData> {
  const teamQuery = await pool.query(
    "SELECT * FROM teams WHERE id = $1 AND deleted_at IS NULL",
    [teamId]
  );

  if (teamQuery.rows.length === 0) {
    throw new Error("Team not found");
  }

  return teamQuery.rows[0];
}

export async function findRelevantContext(
  decodedQuestion: string,
  teamName: string
): Promise<RelevantContext[]> {
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

  const codeEmbeddings = await fetchCodeEmbeddings(
    questionEmbedding,
    teamName,
    decodedQuestion,
    STAKING_PATTERNS
  );

  const relevantEmbeddings = await scoreEmbeddings(
    codeEmbeddings,
    decodedQuestion
  );
  return filterAndSortContext(codeEmbeddings, relevantEmbeddings);
}

async function fetchCodeEmbeddings(
  questionEmbedding: any,
  teamName: string,
  decodedQuestion: string,
  stakingPatterns: string[]
) {
  const query = await pool.query(
    `WITH ranked_matches AS (
      SELECT content, name, location, type, (embedding <=> $1) as similarity
      FROM context_embeddings 
      WHERE company_id = $2 AND (embedding <=> $1) < 0.8
      ORDER BY similarity LIMIT 15
    )
    SELECT *,
      CASE 
        WHEN $2 = 'olas' AND LOWER($3) LIKE ANY($4) AND LOWER(content) LIKE '%pearl%' THEN similarity * 0.3
        WHEN $2 = 'olas' AND LOWER($3) LIKE ANY($4) THEN similarity * 0.5
        WHEN LOWER(content) LIKE $3 THEN similarity * 0.7
        WHEN LOWER(name) LIKE $3 THEN similarity * 0.8
        ELSE similarity
      END as adjusted_similarity
    FROM ranked_matches
    ORDER BY adjusted_similarity`,
    [
      questionEmbedding,
      teamName,
      `%${decodedQuestion.toLowerCase()}%`,
      stakingPatterns,
    ]
  );

  return query.rows.slice(0, 15);
}

async function scoreEmbeddings(codeEmbeddings: any[], decodedQuestion: string) {
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
${embedding.content}`,
            },
          ],
          max_tokens: 10,
          temperature: 0.1,
        });

        const score = parseInt(
          completion.choices[0].message.content?.trim() || "0"
        );
        if (isNaN(score) || score < 0 || score > 10) {
          throw new Error("Invalid score format");
        }

        return { score, index };
      },
      { maxRetries: 3, initialDelay: 1000 }
    )
  );

  return await Promise.all(filterPromises);
}

function filterAndSortContext(
  codeEmbeddings: any[],
  relevantEmbeddings: Array<{ score: number; index: number }>
): RelevantContext[] {
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

  return relevantContext
    .sort((a: any, b: any) => b.similarity - a.similarity)
    .slice(0, 10);
}
// ... existing code ...

export async function* generateConversationResponse(
  question: string,
  messages: any[],
  teamData: TeamData
): AsyncGenerator<ChatResponse> {
  try {
    const decodedQuestion = decodeURIComponent(question);
    const { system_prompt_name, name: teamName } = teamData;
    const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID || "local";
    const cacheKey = `conversation:${deploymentId}:${teamData.id}:${Buffer.from(
      decodedQuestion
    ).toString("base64")}`;

    // Check cache
    try {
      const cachedResponse = await redis.get(cacheKey);
      if (cachedResponse) {
        console.log("Cache hit for question:", decodedQuestion);
        const chunks = JSON.parse(cachedResponse);

        // Stream cached response with artificial delay
        await sleep(500);
        for (const chunk of chunks) {
          await sleep(70 + Math.random() * 50);
          yield { content: chunk };
        }
        yield { content: "", done: true };
        return;
      }
    } catch (cacheError) {
      console.error("Cache error:", cacheError);
    }

    const limitedContext = await findRelevantContext(decodedQuestion, teamName);
    const responseChunks: string[] = [];

    try {
      let chunkCount = 0;
      for await (const chunk of generateChatResponseWithRetry(
        limitedContext,
        messages,
        system_prompt_name
      )) {
        chunkCount++;
        responseChunks.push(chunk);

        if (chunkCount % 50 === 0) {
          console.log(`Streamed ${chunkCount} chunks so far`);
        }

        await sleep(70 + Math.random() * 50);
        yield { content: chunk };
      }

      // Cache the response
      try {
        await redis.set(cacheKey, JSON.stringify(responseChunks), {
          EX: CACHE_TTL,
        });
        console.log("Cached response for question:", decodedQuestion);
      } catch (cacheError) {
        console.error("Error caching response:", cacheError);
      }

      yield { content: "", done: true };
    } catch (error) {
      console.error("Streaming error:", error);
      yield { content: "", error: "Streaming failed" };
    }
  } catch (error) {
    console.error("Error generating conversation response:", error);
    yield { content: "", error: "Failed to generate response" };
  }
}

// Helper function for sleep
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Add cache TTL constant
const CACHE_TTL = 3 * 60 * 60; // 3 hours
