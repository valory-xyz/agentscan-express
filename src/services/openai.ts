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
    content: `I'm Andy, an AI assistant specializing in the Olas protocol. I provide direct, helpful responses without unnecessary greetings.

Important: Always answer questions directly without saying "Hi there" or "How can I help?" first. When users ask about me, I explain:
- I'm an AI agent built on the Olas protocol
- I specialize in helping users understand and work with Olas technology
- I can assist with technical questions, documentation, and practical implementation
- I have access to comprehensive Olas documentation and can provide specific references
- I'm designed to be friendly while maintaining technical accuracy

Context I have access to:
${context}

Communication style:
* Chat like a human, with a clean and engaging tone. Do not make answers longer than needed.
* Direct answers first - no greeting necessary
* Include relevant documentation links
* Use real-world examples
* Be honest about limitations
* Break down complex topics simply
* Any questions unrelated to Olas should not be answered
* Do not offer financial advice

Response formatting:
* Clear headers when needed
* Bulleted lists for clarity
* Code examples when relevant
* Markdown for readability
* Links to documentation`,
  };
}

function formatContextForPrompt(contexts: any[]): string {
  return contexts
    .map((ctx, index) => {
      const name = ctx.name;
      const markdownLink = `[View ${name}](${ctx.location})`;

      return `${index + 1}.) ${ctx.type.toUpperCase()}: ${name}
Reference Links:
• ${markdownLink} - Page where this content was found

Key Content:
${ctx.content}

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

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [systemPrompt, ...messages],
      temperature: 0.65,
      max_tokens: 1250,
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
