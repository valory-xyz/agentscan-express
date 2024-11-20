import openai from "../initalizers/openai";
import pgvector from "pgvector";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// Add type for retry options
interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
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

// Add this new utility function
function removeDuplicateSentences(text: string): string {
  // Split into sentences (considering multiple punctuation marks)
  const sentences = text.split(/(?<=[.!?])\s+/);

  // Enhanced normalization and similarity detection
  const seen = new Set<string>();
  const uniqueSentences = sentences.filter((sentence) => {
    // More aggressive normalization
    const normalized = sentence
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.,!?;:()'"]/g, "")
      .trim();

    // Skip empty or very short sentences
    if (!normalized || normalized.length < 5) {
      return false;
    }

    // Check for exact matches
    if (seen.has(normalized)) {
      return false;
    }

    // Check for high similarity with existing sentences
    for (const existingSentence of seen) {
      const similarity = calculateSimilarity(normalized, existingSentence);
      if (similarity > 0.8) {
        // Threshold for similarity
        return false;
      }
    }

    seen.add(normalized);
    return true;
  });

  return uniqueSentences.join(" ").replace(/\s+/g, " ").trim();
}

// Helper function to calculate similarity between two strings
function calculateSimilarity(str1: string, str2: string): number {
  const words1 = new Set(str1.split(" "));
  const words2 = new Set(str2.split(" "));

  const intersection = new Set([...words1].filter((x) => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

function createSystemPrompt(
  context: string,
  description: string
): ChatCompletionMessageParam {
  return {
    role: "system",
    content: `You are a precise AI assistant explaining OLAS agents and blockchain technology. Your responses must be concise and direct, and formatted in markdown.

Description of the AI agent: ${description}
Relevant code context:
${context}

RULES:
1. Be concise and direct
2. Never repeat information
3. Use short, clear sentences
4. Present information in a logical order
5. Skip unnecessary phrases or transitions
6. Format all responses using markdown:
   - Use headers (##) for main sections
   - Use bullet points (*) for lists
   - Use code blocks (\`\`) for code snippets
   - Use bold (**) for emphasis
   - Use tables where appropriate

`,
  };
}

// Update the streaming function to process content in larger chunks
export async function* generateChatResponseWithRetry(
  context: string[],
  messages: ChatCompletionMessageParam[],
  description: string,
  options?: RetryOptions
) {
  const contextString = context
    .map((ctx, index) => `${index + 1}.) ${ctx}`)
    .join("\n");

  const systemPrompt = createSystemPrompt(contextString, description);

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [systemPrompt, ...messages],
      temperature: 0.5,
      max_tokens: 4000,
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
