import e, { Router } from "express";
import { pool } from "../../initalizers/postgres";
import {
  generateChatResponseWithRetry,
  generateEmbeddingWithRetry,
} from "../../services/openai";

const router = Router();

router.post("/", async (req, res) => {
  const question = req.body.question;
  const messages = req.body.messages;

  if (!question) {
    return res.status(400).json({ message: "question is required." });
  }
  //decode URI
  const decodedQuestion = decodeURIComponent(question as string);
  console.log(`Decoded question: ${decodedQuestion}`);

  const questionEmbedding = await generateEmbeddingWithRetry(decodedQuestion);

  // Query code embeddings using HNSW vector similarity search
  const codeEmbeddingsQuery = await pool.query(
    `SELECT 
      *,
      embedding <=> $1 as similarity
    FROM context_embeddings 
    WHERE company_id = $2
    ORDER BY similarity
    LIMIT 7`,
    [questionEmbedding, "olas"]
  );

  const codeEmbeddings = codeEmbeddingsQuery.rows;
  console.log("Code embeddings:", JSON.stringify(codeEmbeddings, null, 2));
  const rawContext = codeEmbeddings.map((embedding) => ({
    content: embedding.content,
    name: embedding.name,
    location: embedding.location ? new URL(embedding.location).toString() : "",
    original_content: embedding.original_content
      ? new URL(embedding.original_content).toString()
      : "",
    type: embedding.type || "code",
  }));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    for await (const chunk of generateChatResponseWithRetry(
      rawContext,
      messages
    )) {
      // Add a random delay between 75-125ms to simulate human-like typing
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * 50 + 75)
      );
      res.write(`${JSON.stringify({ content: chunk })}\n\n`);
    }

    res.write(`${JSON.stringify({ done: true })}\n\n`);
  } catch (error) {
    console.error("Streaming error:", error);
    res.write(`${JSON.stringify({ error: "Streaming failed" })}\n\n`);
  } finally {
    res.end();
  }
});

export default router;
