import { chromium } from "playwright";
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
  concurrency: 2, // Reduced further for Railway
  timeout: 180000, // Increased timeout
  throwOnTimeout: true,
}).on("error", async (error) => {
  console.error(`Database operation failed: ${error.message}`);
});

// Add type for retry options
interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
}

// Add a crawling queue to limit concurrent page scraping
const crawlQueue = new PQueue({
  concurrency: 2, // Reduced for Railway
  interval: 5000, // Increased interval
});

// Add these timeout constants at the top
const TIMEOUTS = {
  PAGE_LOAD: 30000, // 30 seconds for initial page load
  SCRAPE_OPERATION: 45000, // 45 seconds for scraping content
  FILTER_CONTENT: 60000, // 60 seconds for content filtering
  EMBEDDING_GENERATION: 30000, // 30 seconds for embedding generation
};

// Add these new timeout constants
const CRAWL_TIMEOUTS = {
  BATCH_PROCESSING: 180000, // 3 minutes per batch
  SINGLE_URL_CRAWL: 60000, // 1 minute per URL
};

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
  try {
    // Check cache first
    const cached = embeddingCache.get(text);
    if (cached) return cached;

    const embeddingPromise = withRetry(async () => {
      const response = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
        dimensions: 512,
      });
      return toSql(response.data?.[0]?.embedding);
    }, options);

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Embedding generation timeout")),
        TIMEOUTS.EMBEDDING_GENERATION
      )
    );

    const embedding = await Promise.race([embeddingPromise, timeoutPromise]);

    // Cache the result
    embeddingCache.set(text, embedding);
    return embedding;
  } catch (error) {
    console.error("Fatal error in generateEmbeddingWithRetry:", error);
    return []; // Return empty embedding instead of crashing
  }
}

// Add this utility function near the top of the file
function normalizeUrl(url: string): string {
  try {
    const parsedUrl = new URL(url);
    // Remove trailing slashes, convert to lowercase, remove 'www.', and remove hash fragments
    return parsedUrl
      .toString()
      .toLowerCase()
      .replace(/\/$/, "") // Remove trailing slash
      .replace(/^https?:\/\/www\./i, "https://") // Normalize www and protocol
      .replace(/#.*$/, ""); // Remove hash fragments
  } catch (error) {
    return url;
  }
}

// Add interface near the top of file
interface ScrapedContent {
  bodyText: string;
  links: string[];
}

// Update scrape_website function
async function scrape_website(url: string) {
  try {
    return withRetry(
      async () => {
        let browser;
        try {
          console.log(`Starting scrape for ${url}`);

          const launchOptions = {
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
          };

          console.log(`Attempting to launch browser for ${url}`);
          browser = await chromium.launch(launchOptions);
          console.log(`Browser launched successfully for ${url}`);

          const context = await browser.newContext();
          const page = await context.newPage();
          console.log(`New page created for ${url}`);

          try {
            console.log(`Navigating to ${url}`);
            await page.goto(url, {
              waitUntil: "networkidle",
              timeout: TIMEOUTS.PAGE_LOAD,
            });

            // Add timeout for content scraping
            const contentPromise = page.evaluate(() => {
              const links = Array.from(document.querySelectorAll("a"))
                .map((link) => link.href)
                .filter((href) => href && !href.startsWith("javascript:")); // Filter out javascript: links

              // Remove duplicates using Set
              const uniqueLinks = [...new Set(links)];

              return {
                bodyText: document.body.innerText,
                links: uniqueLinks,
              };
            });

            const timeoutPromise = new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Content scraping timeout")),
                TIMEOUTS.SCRAPE_OPERATION
              )
            );

            const content = (await Promise.race([
              contentPromise,
              timeoutPromise,
            ])) as ScrapedContent;

            // Normalize all links
            content.links = content.links.map(normalizeUrl).filter(
              (link, index, self) =>
                // Remove duplicates after normalization
                self.indexOf(link) === index &&
                // Ensure link is valid
                isValidUrl(link)
            );

            return content;
          } finally {
            await context.close();
            await browser.close();
          }
        } catch (error: any) {
          console.error("Browser operation error:", {
            message: error.message,
            stack: error.stack,
            code: error.code,
            signal: error.signal,
            url: url,
          });
          if (browser) {
            await browser
              .close()
              .catch((closeError) =>
                console.error("Error closing browser:", closeError)
              );
          }
          throw error;
        }
      },
      {
        maxRetries: 3,
        initialDelay: 2000,
      }
    );
  } catch (error) {
    console.error("Fatal error in scrape_website:", error);
    return { bodyText: "", links: [] }; // Return empty result instead of crashing
  }
}

// Update filter_content function
async function filter_content(raw_text: string) {
  try {
    // Skip processing if text is empty or too short
    if (!raw_text || raw_text.length < 50) {
      console.log("Raw text too short, skipping filtering");
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
      
      ${raw_text.slice(0, 8000).replace(/\n/g, " ")}
    `;

    console.log(`Attempting to filter content of length: ${raw_text.length}`);

    const filterPromise = withRetry(
      async () => {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 4000,
          temperature: 0.3,
          presence_penalty: -0.5,
          frequency_penalty: 0.3,
        });
        console.log("OpenAI API response received");
        return completion;
      },
      { maxRetries: 3, initialDelay: 1000 }
    );

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Content filtering timeout")),
        TIMEOUTS.FILTER_CONTENT
      )
    );

    const response = (await Promise.race([
      filterPromise,
      timeoutPromise,
    ])) as any;

    if (!response || !response?.choices || !response.choices[0]?.message) {
      console.error("No response from OpenAI API");
      return null;
    }

    const filtered_content = response.choices[0]?.message?.content?.trim();

    // Add detailed logging
    console.log({
      hasResponse: !!response,
      hasChoices: !!response.choices?.length,
      hasMessage: !!response.choices?.[0]?.message,
      contentLength: filtered_content?.length || 0,
    });

    // Validate output
    if (!filtered_content || filtered_content.length < 50) {
      console.warn("Filtered content seems too short or empty");
      return null;
    }

    console.log(
      `Successfully filtered content. New length: ${filtered_content.length}`
    );
    return filtered_content;
  } catch (error) {
    console.error("Fatal error in filter_content:", error);
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
  try {
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
  } catch (error) {
    console.error("Fatal error in updateProcessingStatus:", error);
    // No return needed as function is void
  }
}

// Add this function near the top with other utility functions
function isValidUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);

    // Skip search-related URLs
    if (
      parsedUrl.search || // Has query parameters
      parsedUrl.pathname.includes("search") ||
      parsedUrl.pathname.includes("?q=")
    ) {
      return false;
    }

    // Skip common search parameter patterns
    const searchPatterns = ["/search", "query=", "q=", "search="];
    if (searchPatterns.some((pattern) => url.includes(pattern))) {
      return false;
    }

    return true;
  } catch (error) {
    return false;
  }
}

// Update the crawl_website function to use the validation
export async function crawl_website(
  base_url: string,
  max_depth: number = 20,
  organization_id: string,
  currentDepth: number = 0
) {
  try {
    const failedLinks = new Set<string>();
    const normalizedBaseUrl = normalizeUrl(base_url);

    // Skip invalid URLs early
    if (!isValidUrl(normalizedBaseUrl)) {
      console.log(`Skipping invalid or search URL: ${normalizedBaseUrl}`);
      return [];
    }

    const urlId = crypto
      .createHash("sha256")
      .update(normalizedBaseUrl)
      .digest("hex");

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
        console.log(`Updating processing status for ${base_url}`);
        await updateProcessingStatus(
          urlId,
          base_url,
          ProcessingStatus.PROCESSING,
          organization_id
        );
      }

      console.log(`Starting scrape for ${base_url}`);
      const { bodyText, links } = await scrape_website(base_url);
      console.log(
        `Scraped content for ${base_url}, content length: ${bodyText.length}`
      );

      // Only filter and process content if it hasn't been processed before
      if (shouldProcessContent) {
        console.log(`Starting content filtering for ${base_url}`);
        const filtered_content = await filter_content(bodyText);
        console.log(
          `Filtered content for ${base_url}, filtered length: ${
            filtered_content?.length || 0
          }`
        );

        if (filtered_content) {
          console.log(`Starting document processing for ${base_url}`);
          const success = await processDocument(
            base_url,
            filtered_content,
            organization_id
          );
          console.log(
            `Document processing ${
              success ? "succeeded" : "failed"
            } for ${base_url}`
          );

          await updateProcessingStatus(
            urlId,
            base_url,
            success ? ProcessingStatus.COMPLETED : ProcessingStatus.FAILED,
            organization_id,
            success ? undefined : "Failed to process document"
          );
        } else {
          console.log(`No filtered content produced for ${base_url}`);
          await updateProcessingStatus(
            urlId,
            base_url,
            ProcessingStatus.FAILED,
            organization_id,
            "No content after filtering"
          );
        }
      }

      const processedUrls = new Set();
      console.log(
        `Processing ${links.length} links from ${base_url} (depth: ${max_depth})`
      );

      // Create batches of links
      const BATCH_SIZE = 8;
      const linkBatches = [];
      for (let i = 0; i < links.length; i += BATCH_SIZE) {
        linkBatches.push(links.slice(i, i + BATCH_SIZE));
      }

      for (const batch of linkBatches) {
        try {
          console.log(
            `[Depth ${currentDepth}/${max_depth}] Processing batch of ${batch.length} links`
          );

          // Add timeout wrapper for entire batch
          const batchPromise = Promise.all(
            batch
              .map((link) => {
                if (link.startsWith("/")) {
                  link = new URL(link, normalizedBaseUrl).toString();
                }
                const normalizedLink = normalizeUrl(link);

                // Skip if already processed
                if (processedUrls.has(normalizedLink)) {
                  console.log(
                    `[Depth ${currentDepth}] Skipping already processed: ${normalizedLink}`
                  );
                  return null;
                }
                processedUrls.add(normalizedLink);

                if (
                  normalizedLink.startsWith(normalizedBaseUrl) &&
                  max_depth > 0 &&
                  isValidUrl(normalizedLink)
                ) {
                  return crawlQueue.add(async () => {
                    const singleCrawlPromise = withRetry(
                      async () => {
                        return crawl_website(
                          normalizedLink,
                          max_depth - 1,
                          organization_id,
                          currentDepth + 1
                        );
                      },
                      {
                        maxRetries: 2, // Reduced retries
                        initialDelay: 2000,
                      }
                    );

                    // Add timeout for single URL crawl
                    return Promise.race([
                      singleCrawlPromise,
                      new Promise((_, reject) =>
                        setTimeout(
                          () =>
                            reject(
                              new Error(`Timeout crawling ${normalizedLink}`)
                            ),
                          CRAWL_TIMEOUTS.SINGLE_URL_CRAWL
                        )
                      ),
                    ]);
                  });
                }
                return null;
              })
              .filter(Boolean)
          );

          // Add timeout for entire batch
          const results = (await Promise.race([
            batchPromise,
            new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `Timeout processing batch of ${batch.length} links`
                    )
                  ),
                CRAWL_TIMEOUTS.BATCH_PROCESSING
              )
            ),
          ])) as PromiseSettledResult<any>[];

          // Log batch results
          const successful = results.filter(
            (r) => r.status === "fulfilled"
          ).length;
          const failed = results.filter((r) => r.status === "rejected").length;
          console.log(`Completed processing batch for ${base_url}:`, {
            successful,
            failed,
            batchSize: batch.length,
            remainingLinks: links.length - processedUrls.size,
          });

          // Add a small delay between batches to prevent overwhelming the system
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`[Depth ${currentDepth}] Batch processing error:`, {
            error: error instanceof Error ? error.message : error,
            currentDepth,
            batchSize: batch.length,
            queueSize: crawlQueue.size,
          });
          continue;
        }
      }
    } catch (error: any) {
      console.error(`Failed to process ${base_url}:`, {
        error: error.message,
        stack: error.stack,
        phase: "crawl_website",
      });
      await updateProcessingStatus(
        urlId,
        base_url,
        ProcessingStatus.FAILED,
        organization_id,
        error.message
      );
      return [];
    }
  } catch (error) {
    console.error("Fatal error in crawl_website:", error);
    return []; // Return empty array instead of crashing
  }
}

// Update processDocument function to use normalized URL
async function processDocument(
  url: string,
  cleanedCodeContent: string,
  organization_id: string
): Promise<boolean> {
  try {
    const normalizedUrl = normalizeUrl(url);
    console.log(`Processing document: ${normalizedUrl}`);
    const hash = crypto
      .createHash("sha256")
      .update(normalizedUrl)
      .digest("hex");
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
    console.error("Fatal error in processDocument:", error);
    return false;
  }
}
