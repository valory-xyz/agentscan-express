import e, { Router } from "express";
import { pool } from "../../initalizers/postgres";
import {
  generateChatResponseWithRetry,
  generateEmbeddingWithRetry,
} from "../../services/openai";
import { withRetry } from "../../services/crawler";
import openai from "../../initalizers/openai";

const router = Router();

router.post("/", async (req, res) => {
  console.log(
    "Starting conversation request with question:",
    req.body.question
  );

  const question = req.body.question;
  const messages = req.body.messages;

  if (!question) {
    return res.status(400).json({ message: "question is required." });
  }
  //decode URI
  const decodedQuestion = decodeURIComponent(question as string);

  const questionEmbedding = await generateEmbeddingWithRetry(decodedQuestion);
  console.log("Generated embedding for question");

  const codeEmbeddingsQuery = await pool.query(
    `SELECT 
      content,
      name,
      location,
      type,
      embedding <=> $1 as similarity
    FROM context_embeddings 
    WHERE company_id = $2
    ORDER BY similarity
    LIMIT 24`,
    [questionEmbedding, "olas"]
  );
  console.log(
    `Retrieved ${codeEmbeddingsQuery.rows.length} initial embeddings`
  );

  const codeEmbeddings = codeEmbeddingsQuery.rows;

  //for each code embedding, ask if it is relevant to the question
  const filterPromises = codeEmbeddings.map((embedding, index) =>
    withRetry(
      async () => {
        const completion = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
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

  console.log("Relevant indices:", relevantIndices);

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
  console.log(`Final limited context count: ${limitedContext.length}`);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  console.log("Headers set, beginning streaming response");

  try {
    let chunkCount = 0;
    for await (const chunk of generateChatResponseWithRetry(
      limitedContext,
      messages
    )) {
      chunkCount++;
      if (chunkCount % 50 === 0) {
        console.log(`Streamed ${chunkCount} chunks so far`);
      }

      try {
        res.write(`${JSON.stringify({ content: chunk })}\n\n`);
      } catch (writeError) {
        console.error("Error writing chunk:", writeError);
        throw writeError;
      }
    }
    console.log(
      `Streaming completed successfully. Total chunks: ${chunkCount}`
    );

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
