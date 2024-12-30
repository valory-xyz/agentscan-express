import openai from "../initalizers/openai";
import pgvector from "pgvector";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// Add type for retry options
interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
}

// Add these constants at the top of the file
export const MAX_TOKENS = 2000; // Significantly reduced from 4000
export const TOKEN_OVERLAP = 25; // Reduced from 50
export const MIN_CHUNK_LENGTH = 100;
export const ABSOLUTE_MAX_TOKENS = 7000; // Reduced from 8000

type PromptType = "general" | "agent";

// Helper function to estimate tokens (rough approximation)
export function estimateTokens(text: string): number {
  // More aggressive token estimation
  if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
    // Even more conservative for JSON/ABI content
    return Math.ceil(text.length / 2); // Changed from 2.5 to 2
  }
  const hasCode = /[{}\[\]()]/g.test(text);
  return Math.ceil(text.length / (hasCode ? 2 : 3)); // More conservative estimates
}

// Content-specific token limits
const TOKEN_LIMITS = {
  ABI: {
    MAX_TOKENS: 1000,
    TOKEN_OVERLAP: 20,
    MIN_CHUNK_LENGTH: 50,
    ABSOLUTE_MAX: 6000,
  },
  CODE: {
    MAX_TOKENS: 5000,
    TOKEN_OVERLAP: 100,
    MIN_CHUNK_LENGTH: 100,
    ABSOLUTE_MAX: 7000,
  },
  DEFAULT: {
    MAX_TOKENS: 7500,
    TOKEN_OVERLAP: 200,
    MIN_CHUNK_LENGTH: 100,
    ABSOLUTE_MAX: 7500,
  },
};

// ABI detection
function isABI(text: string): boolean {
  try {
    const content = JSON.parse(text);
    if (!Array.isArray(content)) return false;

    return content.some(
      (item) =>
        item &&
        typeof item === "object" &&
        ((item.type &&
          ["function", "event", "constructor"].includes(item.type)) ||
          (item.inputs && Array.isArray(item.inputs)) ||
          (item.stateMutability && typeof item.stateMutability === "string"))
    );
  } catch {
    return false;
  }
}

export function splitTextIntoChunks(
  text: string,
  maxTokens: number = TOKEN_LIMITS.DEFAULT.MAX_TOKENS
): string[] {
  if (!text) return [];

  // Determine content type and get appropriate limits
  let limits = TOKEN_LIMITS.DEFAULT;
  if (isABI(text)) {
    console.log("Detected ABI content, using specialized splitting...");
    limits = TOKEN_LIMITS.ABI;
    return splitABIContent(text, limits);
  } else if (/[{}\[\]()]/g.test(text)) {
    console.log("Detected code content, using code-specific splitting...");
    limits = TOKEN_LIMITS.CODE;
  }

  const actualMaxTokens = Math.min(maxTokens, limits.ABSOLUTE_MAX);
  const chunks: string[] = [];

  // Helper function to safely add chunks
  const addChunk = (chunk: string) => {
    const trimmed = chunk.trim();
    if (trimmed.length >= limits.MIN_CHUNK_LENGTH) {
      const estimatedSize = estimateTokens(trimmed);
      if (estimatedSize <= limits.ABSOLUTE_MAX) {
        chunks.push(trimmed);
      } else {
        // Split large chunks into smaller pieces
        const subChunks = splitBySize(trimmed, actualMaxTokens, limits);
        chunks.push(...subChunks);
      }
    }
  };

  // Helper function for splitting by size
  const splitBySize = (
    text: string,
    maxSize: number,
    limits: typeof TOKEN_LIMITS.DEFAULT
  ): string[] => {
    const localChunks: string[] = [];
    let current = "";
    let currentSize = 0;
    const words = text.split(/\s+/);

    for (const word of words) {
      const wordSize = estimateTokens(word);
      if (currentSize + wordSize > maxSize - limits.TOKEN_OVERLAP) {
        if (current) {
          localChunks.push(current.trim());
          current = "";
          currentSize = 0;
        }
      }
      current = current ? `${current} ${word}` : word;
      currentSize += wordSize;
    }

    if (current) {
      localChunks.push(current.trim());
    }

    return localChunks;
  };

  // Specialized function for splitting ABI content
  function splitABIContent(
    abiText: string,
    limits: typeof TOKEN_LIMITS.ABI
  ): string[] {
    try {
      const abi = JSON.parse(abiText);
      const chunks: string[] = [];
      let currentChunk: any[] = [];
      let currentSize = 0;

      for (const item of abi) {
        const itemString = JSON.stringify(item);
        const itemSize = estimateTokens(itemString);

        // If single item is too large, split it
        if (itemSize > limits.MAX_TOKENS) {
          if (currentChunk.length > 0) {
            chunks.push(JSON.stringify(currentChunk));
            currentChunk = [];
            currentSize = 0;
          }
          // Split large item into smaller pieces
          const subChunks = splitBySize(itemString, limits.MAX_TOKENS, limits);
          chunks.push(...subChunks);
          continue;
        }

        // Check if adding this item would exceed the limit
        if (currentSize + itemSize > limits.MAX_TOKENS - limits.TOKEN_OVERLAP) {
          chunks.push(JSON.stringify(currentChunk));
          currentChunk = [];
          currentSize = 0;
        }

        currentChunk.push(item);
        currentSize += itemSize;
      }

      // Add remaining items
      if (currentChunk.length > 0) {
        chunks.push(JSON.stringify(currentChunk));
      }

      return chunks;
    } catch (error) {
      console.error("Error splitting ABI:", error);
      // Fallback to regular splitting if JSON parsing fails
      return splitBySize(abiText, limits.MAX_TOKENS, limits);
    }
  }

  // Handle regular text content
  if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) {
    const segments = text.split(/(?<=\.|\?|\!)\s+/);
    let currentChunk = "";
    let currentSize = 0;

    for (const segment of segments) {
      const segmentSize = estimateTokens(segment);

      if (currentSize + segmentSize > actualMaxTokens - limits.TOKEN_OVERLAP) {
        if (currentChunk) {
          addChunk(currentChunk);
          currentChunk = "";
          currentSize = 0;
        }
      }

      currentChunk = currentChunk ? `${currentChunk} ${segment}` : segment;
      currentSize += segmentSize;
    }

    if (currentChunk) {
      addChunk(currentChunk);
    }
  }

  return chunks;
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
): Promise<any> {
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  const estimatedTokens = estimateTokens(text);

  // If text might be too long, split it before attempting embedding
  if (estimatedTokens > MAX_TOKENS) {
    console.log("Text too long for single embedding, splitting into chunks...");
    const chunks = splitTextIntoChunks(text, MAX_TOKENS);
    console.log(`Split into ${chunks.length} chunks`);

    const embeddings: any[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(
        `Processing chunk ${i + 1}/${
          chunks.length
        } (estimated tokens: ${estimateTokens(chunk)})`
      );

      try {
        // Double-check chunk size
        if (estimateTokens(chunk) > MAX_TOKENS) {
          console.log(`Chunk ${i + 1} still too large, further splitting...`);
          const subChunks = splitTextIntoChunks(chunk, MAX_TOKENS / 2);
          for (let j = 0; j < subChunks.length; j++) {
            const subChunk = subChunks[j];
            const embedding = await withRetry(async () => {
              const response = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: subChunk,
                dimensions: 512,
              });
              return pgvector.toSql(response.data?.[0]?.embedding);
            }, options);
            embeddings.push(embedding);
          }
        } else {
          const embedding = await withRetry(async () => {
            const response = await openai.embeddings.create({
              model: "text-embedding-3-small",
              input: chunk,
              dimensions: 512,
            });
            return pgvector.toSql(response.data?.[0]?.embedding);
          }, options);
          embeddings.push(embedding);
        }
      } catch (error) {
        console.error(`Error processing chunk ${i + 1}:`, error);
      }
    }
    return embeddings;
  } else {
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
}

// Add this type definition
interface DocumentReference {
  name: string;
  location: string;
  type: string;
  content: string;
}

// First, update extractValidLinks to accept transactions
function extractValidLinks(
  contexts: DocumentReference[],
  transactions?: any[]
): Map<string, string> {
  const validLinks = new Map<string, string>();

  contexts.forEach((ctx) => {
    validLinks.set(ctx.name.toLowerCase(), ctx.location);

    const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;
    while ((match = linkPattern.exec(ctx.content)) !== null) {
      validLinks.set(match[1].toLowerCase(), match[2]);
    }
  });

  // Add transaction links
  if (transactions?.length) {
    transactions.forEach((tx, index) => {
      if (tx.transactionLink) {
        validLinks.set(`transaction ${index + 1}`, tx.transactionLink);
        validLinks.set(tx.transactionHash.toLowerCase(), tx.transactionLink);
      }
    });
  }

  return validLinks;
}

function formatAddress(address: string, chain: string = "mainnet"): string {
  const abbreviated = `${address.slice(0, 5)}...${address.slice(-4)}`;
  const explorerUrl =
    chain === "mainnet"
      ? `https://etherscan.io/address/${address}`
      : chain === "gnosis"
        ? `https://gnosisscan.io/address/${address}`
        : `https://basescan.org/address/${address}`;
  return `[${abbreviated}](${explorerUrl})`;
}

function createSystemPrompt(
  context: string,
  validLinks: Map<string, string>,
  system_prompt_name: string,
  promptType: PromptType = "general",
  agent?: { name: string; description: string } | null,
  transactions?: any[]
): ChatCompletionMessageParam {
  const promptTemplates = {
    general: `I'm Andy, and I speak directly to users about my capabilities and expertise with the ${system_prompt_name}. I avoid unnecessary greetings and get straight to helping.

About me:
- I'm an AI agent built on the ${system_prompt_name}
- I specialize in helping you understand and work with ${system_prompt_name} technology
- I excel at analyzing transaction logs, ABIs, and smart contract interactions
- I can decode and explain complex transaction data and event logs
- I can assist you with technical questions, documentation, and practical implementation
- I can help you create and implement custom agents (with appropriate disclaimers)
- I provide code examples and implementation guidance when requested
- I aim to be friendly while maintaining technical accuracy in our conversations

When helping with agent creation:
- I provide detailed code examples and explanations
- I include necessary contract interfaces and implementations
- I explain key considerations and best practices
- I always include appropriate risk disclaimers
- I emphasize the importance of testing and security
- I suggest ways to improve agent reliability and efficiency`,

    agent: `I'm Andy, an AI specialized in analyzing on-chain agent activities, transaction logs, and smart contract interactions. I provide detailed insights about agent behavior, transaction patterns, and protocol mechanics with a focus on technical details in logs and ABIs.

${
  agent
    ? `I am ${agent.name}.
${agent.description}

I can help you understand:
- My transaction history and behavior patterns
- My decoded transaction logs, events, and function calls
- The ABI specifications I implement
- My contract interactions and their encoded data
- My transaction flows across multiple contracts
- My low-level EVM interactions and their meaning
- My key protocol interactions and their significance
- How I operate within the OLAS ecosystem
- How to create similar agents (with appropriate disclaimers)
- Implementation details and code examples for agent development

ANALYSIS APPROACH:
- I examine my transaction logs and decoded data for detailed insights
- I interpret my ABI specifications to explain my interfaces
- I analyze my event logs and their parameters thoroughly
- I trace my function calls and their encoded parameters
- I identify patterns in my contract interactions and data usage
- I explain my technical details in clear, accessible terms
- I focus on factual, on-chain evidence in my analysis
- I provide implementation guidance when requested`
    : ""
}

KEY FOCUS AREAS:
- Detailed transaction log analysis and interpretation
- ABI specification and implementation understanding
- Event log decoding and parameter explanation
- Function call tracing and parameter decoding
- Smart contract interaction analysis
- Protocol mechanics and agent behavior
- Technical accuracy in blockchain data interpretation
- Agent development guidance and code examples
- Implementation best practices and security considerations

When providing agent implementation guidance:
- I include necessary disclaimers about risks and testing requirements
- I provide detailed code examples with explanations
- I emphasize security best practices and potential pitfalls
- I suggest testing strategies and validation approaches
- I recommend ways to ensure agent reliability and efficiency`,
  };

  let transactionContext = "";
  if (transactions && transactions.length > 0) {
    const recentTransactions = transactions.slice(-5);
    transactionContext = `
RECENT TRANSACTIONS:
${recentTransactions
  .map((tx, index) => {
    const timestamp = new Date(Number(tx.timestamp) * 1000).toISOString();
    const value = tx.transaction.value
      ? BigInt(tx.transaction.value).toString()
      : "0";

    return `
Transaction ${index + 1}:
Hash: ${tx.transactionHash}
Chain: ${tx.chain}
Timestamp: ${timestamp}
From: ${formatAddress(tx.transaction.from, tx.chain)}
To: ${tx.transaction.to ? formatAddress(tx.transaction.to, tx.chain) : "N/A"}
Value: ${value}
Link: ${tx.transactionLink}`;
  })
  .join("\n---\n")}
`;
  }

  const validLinksWithTransactions = extractValidLinks(
    Array.from(validLinks.entries()).map(([name, location]) => ({
      name,
      location,
      type: "link",
      content: "",
    })),
    transactions
  );
  const linkList = Array.from(validLinksWithTransactions.entries())
    .map(([name, url]) => `- ${name}: ${url}`)
    .join("\n");

  return {
    role: "system",
    content:
      promptTemplates[promptType] +
      `\n\nCONTEXT:
${transactionContext}

IMPORTANT: I can ONLY reference these validated links in my responses:
${linkList}, as well as links to a block explorer for the chain the transaction was on in the format [0xABC...XYZ](explorer-link)

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
* I only answer questions related to ${system_prompt_name}
* I don't provide financial advice`,
  };
}

function formatContextForPrompt(
  contexts: any[],
  agent?: { name: string; description: string } | null
): string {
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
  system_prompt_name: string,
  promptType: PromptType = "general",
  agent?: { name: string; description: string } | null,
  transactions?: any[]
) {
  const contextString = formatContextForPrompt(context);

  const validLinks = extractValidLinks(context, transactions);

  const systemPrompt = createSystemPrompt(
    contextString,
    validLinks,
    system_prompt_name,
    promptType,
    agent,
    transactions
  );

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [systemPrompt, ...messages],
      temperature: 0.7,
      max_tokens: 1250,
      stream: true,
    });

    for await (const chunk of response as any) {
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
