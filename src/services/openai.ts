import openai from "../initalizers/openai";
import pgvector from "pgvector";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// Add type for retry options
interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
}

// Add these constants at the top of the file
export const MAX_TOKENS = 7500; // Slightly below the 8192 limit to provide safety margin
export const TOKEN_OVERLAP = 200;

// Helper function to estimate tokens (rough approximation)
export function estimateTokens(text: string): number {
  // OpenAI generally uses ~4 chars per token for English text
  return Math.ceil(text.length / 4);
}

export function splitTextIntoChunks(text: string, maxTokens: number): string[] {
  if (!text) return [];

  const chunks: string[] = [];
  let currentChunk = "";

  // Split on sentence boundaries first, then fallback to word boundaries
  const sentences = text.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) || [text];

  for (let sentence of sentences) {
    sentence = sentence.trim();
    const sentenceTokens = estimateTokens(sentence);

    // If a single sentence exceeds maxTokens, split it into words
    if (sentenceTokens > maxTokens) {
      const words = sentence.split(/\s+/);

      for (const word of words) {
        const testChunk = currentChunk ? `${currentChunk} ${word}` : word;
        const testChunkTokens = estimateTokens(testChunk);

        if (testChunkTokens > maxTokens - TOKEN_OVERLAP) {
          if (currentChunk) {
            chunks.push(currentChunk.trim());
          }
          currentChunk = word;
        } else {
          currentChunk = testChunk;
        }
      }
    } else {
      // Try to add the sentence to the current chunk
      const testChunk = currentChunk ? `${currentChunk} ${sentence}` : sentence;
      const testChunkTokens = estimateTokens(testChunk);

      if (testChunkTokens > maxTokens - TOKEN_OVERLAP) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }
        currentChunk = sentence;
      } else {
        currentChunk = testChunk;
      }
    }
  }

  // Add the last chunk if it exists
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  // Add overlap between chunks for better context
  return chunks.map((chunk, index) => {
    if (index === 0) return chunk;

    // Get some context from the previous chunk
    const prevChunk = chunks[index - 1] ?? "";
    const overlapText = prevChunk
      .split(/\s+/)
      .slice(-TOKEN_OVERLAP / 20)
      .join(" ");
    return `${overlapText} ${chunk}`;
  });
}

// Add a reusable retry utility
async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, initialDelay = 400 } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries) {
        console.error(`Failed all retry attempts:`, error);
        throw error;
      }
      const delay =
        initialDelay * Math.pow(2, attempt - 1) + Math.random() * 200;
      console.log(`Attempt ${attempt} failed. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Failed after all retries");
}

// Cache for embeddings
const embeddingCache = new Map<string, number[]>();

export async function generateEmbeddingWithRetry(
  text: string,
  options?: RetryOptions
): Promise<number[]> {
  // Check cache first
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  const embedding = await withRetry(async () => {
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
      dimensions: 512,
    });
    return pgvector.toSql(response.data?.[0]?.embedding);
  }, options);

  // Cache the result
  embeddingCache.set(text, embedding);
  return embedding;
}

function createSystemPrompt(context: string): ChatCompletionMessageParam {
  return {
    role: "system",
    content: `I'm Andy, an AI agent built on Olas protocol. I provide direct, concise answers about Olas technology.

Key points:
- I specialize in Olas technology and documentation
- I MUST ONLY use the exact URLs provided after "LINK_URL:" in the context
- Each reference includes a pre-formatted link showing exactly how to reference that component
- Never create or modify URLs - copy them exactly as shown in "Available link:" sections
- Never use parentheses with plain text - always convert to hyperlinks using the exact URLs provided
- If I don't have a matching URL in the context references, mention the component without parentheses

INCORRECT: Trading autonomously in DeFi (e.g., BabyDegen)
CORRECT: Trading autonomously in DeFi (e.g., copy the exact [BabyDegen](URL) from the context)

IMPORTANT: Only use URLs that appear after "LINK_URL:" in the context. Never modify or create URLs.

Context:
${context}`,
  };
}

function formatContextForPrompt(contexts: any[]): string {
  return contexts
    .map((ctx, index) => {
      const name = ctx.name;
      const location = ctx.location;
      const type = ctx.type.toUpperCase();

      return `REFERENCE ${index + 1}:
TYPE: ${type}
COMPONENT: ${name}
LINK_URL: ${location}
CONTENT: ${ctx.content}

Available link: [${name}](${location})

---
`;
    })
    .join("\n");
}

// Update the streaming function to process content in larger chunks
export async function* generateChatResponseWithRetry(
  context: any[],
  messages: ChatCompletionMessageParam[],
  options?: RetryOptions
) {
  const contextString = formatContextForPrompt(context);
  const systemPrompt = createSystemPrompt(contextString);
  // console.log("System prompt:", systemPrompt);
  // console.log("Messages:", messages);

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [systemPrompt, ...messages],
      temperature: 0.65,
      max_tokens: 1000,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  } catch (error) {
    console.error("Streaming error:", error);
    throw error;
  }
}
