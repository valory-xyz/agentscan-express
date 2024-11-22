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

// Add this type definition
interface DocumentReference {
  name: string;
  location: string;
  type: string;
  content: string;
}

// Add this validation utility
function extractValidLinks(contexts: DocumentReference[]): Map<string, string> {
  const validLinks = new Map<string, string>();
  contexts.forEach((ctx) => {
    validLinks.set(ctx.name.toLowerCase(), ctx.location);
    // Extract any additional links from the content if they follow a specific pattern
    // For example: [link_text](url)
    const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;
    while ((match = linkPattern.exec(ctx.content)) !== null) {
      validLinks.set(match[1].toLowerCase(), match[2]);
    }
  });
  return validLinks;
}

function createSystemPrompt(
  context: string,
  validLinks: Map<string, string>
): ChatCompletionMessageParam {
  const linkList = Array.from(validLinks.entries())
    .map(([text, url]) => `- ${text}: ${url}`)
    .join("\n");

  return {
    role: "system",
    content: `I'm Andy, and I speak directly to users about my capabilities and expertise with the Olas protocol. I avoid unnecessary greetings and get straight to helping.

About me:
- I'm an AI agent built on the Olas protocol
- I specialize in helping you understand and work with Olas technology
- I can assist you with technical questions, documentation, and practical implementation
- I have direct access to comprehensive Olas documentation and can point you to specific references
- I aim to be friendly while maintaining technical accuracy in our conversations

IMPORTANT: I can ONLY reference these validated links in my responses:
${linkList}

I have access to this context:
${context}

How I communicate:
* I only use hyperlinks from my validated link list
* I never create or imagine links that aren't in my validated set
* If I need to reference something without a valid link, I mention it without creating a link
* I structure information in layers - basic explanation first, followed by validated linked resources
* I chat naturally while keeping responses concise and focused
* I get straight to answers without greetings
* I'm direct about what I can and cannot help with
* I break down complex topics into simpler terms
* I only answer questions related to Olas
* I don't provide financial advice`,
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
NAME: ${name}
LINK: ${location}
CONTENT:
${ctx.content}

---
`;
    })
    .join("\n");
}

// Update the streaming function to process content in larger chunks
export async function* generateChatResponseWithRetry(
  context: DocumentReference[],
  messages: ChatCompletionMessageParam[],
  options?: RetryOptions
) {
  const contextString = formatContextForPrompt(context);
  const validLinks = extractValidLinks(context);
  const systemPrompt = createSystemPrompt(contextString, validLinks);

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [systemPrompt, ...messages],
      temperature: 0.7,
      max_tokens: 2000,
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
