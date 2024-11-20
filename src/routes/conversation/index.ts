import { Router } from "express";
import { pool } from "../../initalizers/postgres";
import {
  generateChatResponseWithRetry,
  generateEmbeddingWithRetry,
} from "../../services/openai";

const router = Router();

router.post("/", async (req, res) => {
  const agentId = req.body.agentId;
  const question = req.body.question;
  const messages = req.body.messages;

  if (!agentId || !question) {
    return res
      .status(400)
      .json({ message: "Agent ID and question are required." });
  }
  //decode URI
  const decodedQuestion = decodeURIComponent(question as string);

  //get agent from db
  const agentQuery = await pool.query(
    "SELECT * FROM component_agent WHERE agent_id = $1",
    [agentId]
  );

  //query agent description
  const agentDescriptionQuery = await pool.query(
    "SELECT description FROM agent WHERE id = $1 LIMIT 1",
    [agentId]
  );
  const agentDescription = agentDescriptionQuery.rows[0].description;

  const agentResults = agentQuery.rows;
  const componentIds = agentResults.map((agent) => agent.component_id);

  //get all dependencies for each component
  const dependenciesQuery = await pool.query(
    "SELECT * FROM component_dependency WHERE component_id = ANY($1)",
    [componentIds]
  );

  const dependencies = dependenciesQuery.rows.map(
    (dependency) => dependency.dependency_id
  );
  //map dependencies to components
  const dependencyMap = new Map<string, string[]>();
  dependencies.forEach((dependency) => {
    if (!dependencyMap.has(dependency.component_id)) {
      dependencyMap.set(dependency.component_id, []);
    }
  });

  const componentIdsWithDependencies = [...componentIds, ...dependencies];
  //remove duplicates
  const uniqueComponentIdsWithDependencies = [
    ...new Set(componentIdsWithDependencies),
  ];

  // Get embeddings for the question using your embedding service
  // This is a placeholder - you'll need to implement this
  const questionEmbedding = await generateEmbeddingWithRetry(decodedQuestion);

  // Query code embeddings using HNSW vector similarity search
  const codeEmbeddingsQuery = await pool.query(
    `SELECT 
      component_id,
      file_path,
      code_content,
      embedding <=> $1 as similarity
    FROM code_embeddings 
    WHERE component_id = ANY($2)
    ORDER BY similarity
    LIMIT 6`,
    [questionEmbedding, uniqueComponentIdsWithDependencies]
  );

  const codeEmbeddings = codeEmbeddingsQuery.rows;
  const rawCodeContext = codeEmbeddings.map(
    (embedding) => embedding.code_content
  );

  const codeContext = await Promise.all(
    rawCodeContext.map(async (code, index) => {
      const componentId = codeEmbeddings[index].component_id;
      const componentDescriptionQuery = await pool.query(
        "SELECT description FROM component WHERE id = $1 LIMIT 1",
        [componentId]
      );
      const componentDescription =
        componentDescriptionQuery.rows[0].description;
      return `${index + 1}.) ${
        codeEmbeddings[index].file_path
      }\n${componentDescription}\n${code}`;
    })
  );

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    for await (const chunk of generateChatResponseWithRetry(
      rawCodeContext,
      messages,
      agentDescription
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
