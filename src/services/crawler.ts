import puppeteer from "puppeteer";
import { toSql } from "pgvector";

import PQueue from "p-queue";

import * as crypto from "crypto";
import openai from "../initalizers/openai";

import { MAX_TOKENS, splitTextIntoChunks } from "./openai";
import { executeQuery, safeQueueOperation } from "./postgres";

// Simplify the status enum
enum ProcessingStatus {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
}

// Modify the dbQueue to have lower concurrency
export const dbQueue = new PQueue({
  concurrency: 2, // Reduced from 5
  timeout: 120000,
  throwOnTimeout: true,
}).on("error", async (error) => {
  console.log(`Database operation failed: ${error.message}`);
});

// Add a crawling queue to limit concurrent page scraping
const crawlQueue = new PQueue({
  concurrency: 7, // Only process 3 pages at a time
  interval: 1000, // Add a 1 second interval between tasks
});

async function scrape_website(url: string) {
  return withRetry(
    async () => {
      const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        timeout: 60000,
      });

      const page = await browser.newPage();
      await page.setDefaultNavigationTimeout(45000);
      await page.setDefaultTimeout(45000);

      try {
        await page.setRequestInterception(true);
        page.on("request", (request) => {
          const blockedResourceTypes = ["image", "font", "stylesheet"];
          if (blockedResourceTypes.includes(request.resourceType())) {
            request.abort();
          } else {
            request.continue();
          }
        });

        await page.goto(url, {
          waitUntil: "networkidle2",
          timeout: 60000,
        });

        const content = await page.evaluate(() => {
          const doc = document as Document;
          return {
            bodyText: doc.body.innerText,
            links: Array.from(doc.querySelectorAll("a")).map(
              (link) => link.href
            ),
          };
        });

        return content;
      } finally {
        await browser.close();
      }
    },
    { maxRetries: 3, initialDelay: 1000 }
  );
}

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
    return toSql(response.data?.[0]?.embedding);
  }, options);

  // Cache the result
  embeddingCache.set(text, embedding);
  return embedding;
}

async function filter_content(raw_text: string) {
  // Skip processing if text is empty or too short
  if (!raw_text || raw_text.length < 50) {
    return null;
  }

  const prompt = `
    You are a content extraction specialist. Your task is to:
    1. Extract only the main, meaningful content from the provided text
    2. Remove all of the following:
       - Navigation menus and headers
       - Advertisements
       - Cookie notices
       - Legal disclaimers and footers
       - Social media buttons/widgets
       - Search bars and forms
       - Repetitive elements
    3. Preserve:
       - Main article content
       - Important headings
       - Relevant code examples or technical documentation
       - Key product information
    4. Format the output as clean, readable text

    Return only the processed content, without any explanations.

    Content to process:
    
    ${raw_text
      .slice(0, 8000)
      .replace(/\n/g, " ")} // Limit input size to prevent token overflow
  `;

  try {
    const response = await withRetry(
      async () => {
        return await openai.chat.completions.create({
          model: "gpt-4o-mini", // Updated to latest model
          messages: [{ role: "user", content: prompt }],
          max_tokens: 4000,
          temperature: 0.3, // Reduced for more consistent output
          presence_penalty: -0.5, // Encourage focused responses
          frequency_penalty: 0.3, // Reduce repetition
        });
      },
      { maxRetries: 3, initialDelay: 1000 }
    );

    const filtered_content = response.choices[0]?.message?.content
      ?.trim()
      .replace(/\n/g, " ");

    // Validate output
    if (!filtered_content || filtered_content.length < 50) {
      console.warn("Filtered content seems too short or empty");
      return null;
    }

    return filtered_content;
  } catch (error: any) {
    console.error(`Failed to filter content: ${error.message}`);
    return null;
  }
}

// Add helper function for status updates
async function updateProcessingStatus(
  urlId: string,
  url: string,
  status: ProcessingStatus,
  organization_id: string,
  errorMessage?: string
): Promise<void> {
  await dbQueue.add(async () => {
    await executeQuery(async (client) => {
      if (status === ProcessingStatus.COMPLETED) {
        await client.query(
          `INSERT INTO context_processing_status (
            id,
            company_id,
            type,
            location,
            name,
            status,
            error_message,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (id, type) DO UPDATE SET
            location = EXCLUDED.location,
            name = EXCLUDED.name,
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            updated_at = NOW()`,
          [
            urlId,
            organization_id,
            "document",
            url,
            url,
            status,
            errorMessage || null,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO context_processing_status (
            id,
            company_id,
            type,
            status,
            error_message,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (id, type) DO UPDATE SET
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            updated_at = NOW()`,
          [urlId, organization_id, "document", status, errorMessage || null]
        );
      }
    });
  });
}

// Add this new utility function near the top of the file
function normalizeUrl(url: string): string {
  try {
    const parsedUrl = new URL(url);
    // Remove trailing slashes, convert to lowercase, remove 'www.'
    return parsedUrl
      .toString()
      .toLowerCase()
      .replace(/\/$/, "") // Remove trailing slash
      .replace(/^https?:\/\/www\./i, "https://"); // Normalize www and protocol
  } catch (error) {
    // If URL parsing fails, return original URL
    return url;
  }
}

// Update the crawl_website function to use normalized URL
export async function crawl_website(
  base_url: string,
  max_depth: number = 50,
  organization_id: string
) {
  const normalizedUrl = normalizeUrl(base_url);
  const urlId = crypto.createHash("sha256").update(normalizedUrl).digest("hex");

  // Check status but don't return early
  const status = await dbQueue.add(async () => {
    const result = await executeQuery(async (client) => {
      const res = await client.query(
        `SELECT status FROM context_processing_status 
         WHERE id = $1 AND type = 'document' AND company_id = $2`,
        [urlId, organization_id]
      );
      return res.rows[0]?.status;
    });
    return result;
  });

  const shouldProcessContent = status !== ProcessingStatus.COMPLETED;
  if (!shouldProcessContent) {
    console.log(
      `${base_url} was previously processed - skipping content processing`
    );
  }

  console.log(`Crawling: ${base_url}`);

  try {
    if (shouldProcessContent) {
      await updateProcessingStatus(
        urlId,
        base_url,
        ProcessingStatus.PROCESSING,
        organization_id
      );
    }

    const { bodyText, links } = await scrape_website(base_url);

    // Only filter and process content if it hasn't been processed before
    if (shouldProcessContent) {
      const filtered_content = await filter_content(bodyText);

      if (filtered_content) {
        const success = await processDocument(
          base_url,
          filtered_content,
          organization_id
        );
        if (success) {
          await updateProcessingStatus(
            urlId,
            base_url,
            ProcessingStatus.COMPLETED,
            organization_id
          );
        } else {
          await updateProcessingStatus(
            urlId,
            base_url,
            ProcessingStatus.FAILED,
            organization_id,
            "Failed to process document"
          );
        }
      }
    }

    // Continue with navigation regardless of processing status
    const crawlPromises = links
      .map((link) => {
        if (link.startsWith("/")) {
          link = new URL(link, base_url).toString();
        }
        if (link.startsWith(base_url) && max_depth > 0) {
          link = link.replace(/\/$/, "");
          return crawlQueue.add(() =>
            crawl_website(link, max_depth - 1, organization_id)
          );
        }
      })
      .filter(Boolean); // Filter out undefined promises

    await Promise.all(crawlPromises);
  } catch (error: any) {
    console.error(`Failed to scrape ${base_url}: ${error.message}`);
    await updateProcessingStatus(
      urlId,
      base_url,
      ProcessingStatus.FAILED,
      error.message
    );
    return [];
  }
}

// Update processDocument function to use normalized URL
async function processDocument(
  url: string,
  cleanedCodeContent: string,
  organization_id: string
): Promise<boolean> {
  const normalizedUrl = normalizeUrl(url);
  console.log(`Processing document: ${normalizedUrl}`);
  const hash = crypto.createHash("sha256").update(normalizedUrl).digest("hex");
  try {
    const embeddings = await generateEmbeddingWithRetry(cleanedCodeContent);

    if (!Array.isArray(embeddings) || embeddings.length === 1) {
      // Single embedding case
      const result = await safeQueueOperation(async () => {
        return await dbQueue.add(async () => {
          return await executeQuery(async (client) => {
            const res = await client.query(
              `INSERT INTO context_embeddings (
                id,
                company_id,
                type,
                location,
                content,
                name,
                embedding,
                created_at,
                updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
              ON CONFLICT (id, type, location) DO UPDATE SET
                content = EXCLUDED.content,
                embedding = EXCLUDED.embedding,
                updated_at = NOW()
              RETURNING id`,
              [
                hash,
                organization_id,
                "document",
                url,
                cleanedCodeContent,
                url,
                embeddings,
              ]
            );
            return res.rows.length > 0;
          });
        });
      });
      console.log(`Processed document: ${normalizedUrl}`, result);
      return result === true;
    } else {
      // Multiple chunks case
      const chunks = splitTextIntoChunks(cleanedCodeContent, MAX_TOKENS);
      const results = await Promise.allSettled(
        chunks.map((chunk, i) =>
          safeQueueOperation(async () => {
            const chunkLocation = `${url}#chunk${i + 1}`;
            const chunkHash = crypto
              .createHash("sha256")
              .update(chunkLocation)
              .digest("hex");
            return await dbQueue.add(async () => {
              return await executeQuery(async (client) => {
                const res = await client.query(
                  `INSERT INTO context_embeddings (
                    id,
                    company_id,
                    type,
                    location,
                    content,
                    name,
                    embedding,
                    is_chunk,
                    original_location,
                    created_at,
                    updated_at
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
                  ON CONFLICT (id, type, location) DO UPDATE SET
                    content = EXCLUDED.content,
                    embedding = EXCLUDED.embedding,
                    is_chunk = EXCLUDED.is_chunk,
                    original_location = EXCLUDED.original_location,
                    updated_at = NOW()
                  RETURNING id`,
                  [
                    chunkHash,
                    organization_id,
                    "document",
                    chunkLocation,
                    chunk,
                    `${url} (Part ${i + 1})`,
                    embeddings[i],
                    true,
                    url,
                  ]
                );
                return res.rows.length > 0;
              });
            });
          })
        )
      );
      console.log(`Processed document: ${normalizedUrl}`, results);
      return results.every(
        (result: any) => result.status === "fulfilled" && result.value !== null
      );
    }
  } catch (error) {
    console.error(`Failed to process document for ${url}:`, error);
    return false;
  }
}
