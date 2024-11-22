import { chromium, Browser } from "playwright";
import { toSql } from "pgvector";
import PQueue from "p-queue";
import * as crypto from "crypto";
import openai from "../initalizers/openai";
import { MAX_TOKENS, splitTextIntoChunks } from "./openai";
import { executeQuery, safeQueueOperation } from "./postgres";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import fetch from "node-fetch";
import pdf from "pdf-parse";

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
  PDF_DOWNLOAD: 30000, // 30 seconds for PDF download
  PDF_PROCESSING: 60000, // 60 seconds for PDF processing
};

// Add these new timeout constants
const CRAWL_TIMEOUTS = {
  BATCH_PROCESSING: 300000, // 3 minutes per batch
  SINGLE_URL_CRAWL: 60000, // 1 minute per URL
};

// Add a reusable retry utility
export async function withRetry<T>(
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
    if (cached) {
      console.log(`Embedding cache hit for: ${text}`);
      return cached;
    }

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
    // Handle URLs that start with @ by removing it

    const parsedUrl = new URL(url);
    // Remove trailing slashes, convert to lowercase, remove 'www.', and remove hash fragments
    return parsedUrl
      .toString()
      .toLowerCase()
      .replace(/\/$/, "") // Remove trailing slash
      .replace(/^https?:\/\/www\./i, "https://") // Normalize www and protocol
      .replace(/#.*$/, ""); // Remove hash fragments
  } catch (error) {
    return url; // Return original URL if parsing fails
  }
}

// Add interface near the top of file
interface ScrapedContent {
  bodyText: string;
  links: string[];
}

// Add interface near top of file
interface PDFData {
  text: string;
  // Add other properties if needed
}

// Add this helper function
async function downloadAndProcessPdf(url: string): Promise<string> {
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `temp-${Date.now()}.pdf`);
  let fileCreated = false;

  try {
    console.log(`Downloading PDF from: ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const downloadPromise = fs.promises.writeFile(tempFile, buffer).then(() => {
      fileCreated = true;
      return tempFile;
    });

    const downloadedFile = await Promise.race([
      downloadPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("PDF download timeout")),
          TIMEOUTS.PDF_DOWNLOAD
        )
      ),
    ]);

    console.log(`Processing PDF file: ${downloadedFile}`);
    const processPromise = pdf(
      await fs.promises.readFile(downloadedFile as string),
      {
        max: 0,
        pagerender: function (pageData) {
          return pageData.getTextContent().then(function (textContent: any) {
            return textContent.items
              .map((item: { str: string }) => item.str)
              .join(" ");
          });
        },
      }
    );

    const pdfData = (await Promise.race([
      processPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("PDF processing timeout")),
          TIMEOUTS.PDF_PROCESSING
        )
      ),
    ])) as PDFData;

    // Clean up text content
    const cleanedText = pdfData.text
      .replace(/\s+/g, " ") // Replace multiple spaces with single space
      .replace(/[^\x20-\x7E\n]/g, "") // Remove non-printable characters
      .trim();

    console.log(
      `Successfully extracted ${cleanedText.length} characters from PDF`
    );
    return cleanedText;
  } finally {
    // Only attempt cleanup if the file was actually created
    if (fileCreated) {
      try {
        await fs.promises.unlink(tempFile);
      } catch (err) {
        console.warn(
          `Warning: Could not delete temporary PDF file ${tempFile}:`,
          err
        );
      }
    }
  }
}

// Update isValidUrl function to exclude email links
function isValidUrl(url: string): boolean {
  try {
    // Skip mailto: links
    if (url.toLowerCase().startsWith("mailto:")) {
      return false;
    }

    // Check if URL is a PDF
    if (
      url.toLowerCase().endsWith(".pdf") ||
      url.toLowerCase().includes("/pdf/")
    ) {
      return true;
    }

    // Skip search-related URLs
    if (
      url.toLowerCase().includes("search") ||
      url.toLowerCase().includes("?q=")
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

// Add this function to handle PDF content filtering
async function filter_pdf_content(raw_text: string) {
  try {
    if (!raw_text || raw_text.length < 50) {
      console.log("PDF text too short, skipping filtering");
      return null;
    }

    const prompt = `
      You are a PDF content extraction specialist. Your task is to:
      1. Create a clear, well-structured summary of the PDF content
      2. Include:
         - Main topics and key points
         - Important findings or conclusions
         - Relevant technical details or specifications
         - Key data points or statistics
      3. Remove:
         - Headers and footers
         - Page numbers
         - Redundant information
         - References (unless crucial)
      4. Format the output as clean, readable text
      5. Maintain technical accuracy while improving readability

      Return only the processed content, without any explanations.

      Content to process:
      
      ${raw_text.slice(0, 84500).replace(/\n/g, " ")}
    `;

    console.log(
      `Attempting to filter PDF content of length: ${raw_text.length}`
    );

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
        return completion;
      },
      { maxRetries: 3, initialDelay: 1000 }
    ) as any;

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("PDF content filtering timeout")),
        TIMEOUTS.FILTER_CONTENT
      )
    );

    const response = await Promise.race([filterPromise, timeoutPromise]);

    if (!response?.choices?.[0]?.message?.content) {
      console.error("No response from OpenAI API for PDF processing");
      return null;
    }

    const filtered_content = response.choices[0].message.content.trim();
    console.log(`Filtered content: ${filtered_content}`);

    if (!filtered_content || filtered_content.length < 50) {
      console.warn("Filtered PDF content seems too short or empty");
      return null;
    }

    console.log(
      `Successfully filtered PDF content. New length: ${filtered_content.length}`
    );
    return filtered_content;
  } catch (error) {
    console.error("Fatal error in filter_pdf_content:", error);
    return null;
  }
}

// Add this new browser management utility
let browserInstance: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  try {
    if (!browserInstance) {
      const launchOptions = {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--single-process",
        ],
      };
      browserInstance = await chromium.launch(launchOptions);
    }
    return browserInstance;
  } catch (error) {
    console.error("Failed to launch browser:", error);
    throw error;
  }
}

// Update the scrape_website function
async function scrape_website(url: string): Promise<ScrapedContent> {
  let browser: any = null;
  let context: any = null;
  let page: any = null;

  try {
    // Handle PDF case first
    if (
      url.toLowerCase().endsWith(".pdf") ||
      url.toLowerCase().includes("/pdf/")
    ) {
      console.log(`Detected PDF URL: ${url}`);
      const pdfText = await downloadAndProcessPdf(url);
      const filteredContent = await filter_pdf_content(pdfText);
      return {
        bodyText: filteredContent || pdfText,
        links: [],
      };
    }

    return withRetry(
      async () => {
        try {
          console.log(`Starting scrape for ${url}`);
          // Launch a new browser instance for each scrape
          browser = await chromium.launch({
            headless: true,
            args: [
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-dev-shm-usage",
              "--disable-gpu",
              "--single-process",
            ],
          });

          context = await browser.newContext({
            userAgent:
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          });

          page = await context.newPage();

          await page.setDefaultTimeout(TIMEOUTS.PAGE_LOAD);
          await page.setDefaultNavigationTimeout(TIMEOUTS.PAGE_LOAD);

          console.log(`Navigating to ${url}`);
          await page.goto(url, {
            waitUntil: "networkidle",
            timeout: TIMEOUTS.PAGE_LOAD,
          });

          const content = (await Promise.race([
            page.evaluate(() => {
              const links = Array.from(document.querySelectorAll("a"))
                .map((link) => link.href)
                .filter((href) => href && !href.startsWith("javascript:"));

              const uniqueLinks = [...new Set(links)];
              return {
                bodyText: document.body.innerText,
                links: uniqueLinks,
              };
            }),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Content scraping timeout")),
                TIMEOUTS.SCRAPE_OPERATION
              )
            ),
          ])) as ScrapedContent;

          content.links = content.links
            .map(normalizeUrl)
            .filter(
              (link, index, self) =>
                self.indexOf(link) === index &&
                isValidUrl(link) &&
                !processedUrlsCache.has(link)
            );

          return content;
        } finally {
          // Ensure proper cleanup of resources
          if (page) await page.close().catch(console.error);
          if (context) await context.close().catch(console.error);
          if (browser) await browser.close().catch(console.error);
        }
      },
      {
        maxRetries: 3,
        initialDelay: 2000,
      }
    );
  } catch (error) {
    console.error("Fatal error in scrape_website:", error);
    // Ensure cleanup even on error
    try {
      if (page) await page.close().catch(console.error);
      if (context) await context.close().catch(console.error);
      if (browser) await browser.close().catch(console.error);
    } catch (cleanupError) {
      console.error("Error during cleanup:", cleanupError);
    }
    return { bodyText: "", links: [] };
  }
}

// Add cleanup function for the browser instance
export async function cleanupBrowser(): Promise<void> {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (error) {
      console.error("Error closing browser:", error);
    } finally {
      browserInstance = null;
    }
  }
}

// Update filter_content function
async function filter_content(raw_text: string) {
  try {
    if (!raw_text || raw_text.length < 50) {
      console.log("Raw text too short, skipping filtering");
      return null;
    }

    const prompt = `
      You are a content extraction specialist. Your task is to extract only the meaningful content from web pages while aggressively removing all navigation and UI elements.

      STRICTLY REMOVE all of these elements:
      1. Navigation and UI Elements:
         - Navigation menus and links (e.g., "Home", "About", "Resources", "Learn")
         - Header menus and site sections
         - Sidebar navigation
         - Breadcrumb trails
         - "Get Started" or "Learn More" type links
         - Footer menus and links
      
      2. Marketing and UI Components:
         - Call-to-action buttons
         - Newsletter signup forms
         - Social media buttons/widgets
         - Cookie notices and privacy banners
         - Advertisement sections
         - Download/Install buttons
         - Search bars and forms
      
      3. Metadata and Technical Elements:
         - Copyright notices
         - Terms of service
         - Legal disclaimers
         - Site metadata
         - Timestamps and dates (unless part of article content)
         - Author bylines (unless relevant to content)

      PRESERVE ONLY:
      1. Main content:
         - Article body text
         - Important headings within the main content
         - Relevant technical documentation
         - Actual product information
         - Important data and statistics
         - Code examples (if present)

      Return ONLY the cleaned, relevant content without any navigation elements, marketing components, or UI elements. Format as clean, readable text.

      Content to process:
      
      ${raw_text.slice(0, 84500).replace(/\n/g, " ")}
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

    const filtered_content = response.choices[0]?.message?.content
      ?.trim()
      .replace(/\n/g, "");

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

// Add this near the top with other constants
const processedUrlsCache = new Set<string>();

// Update the crawl_website function to use the validation
export async function crawl_website(
  base_url: string,
  max_depth: number = 7,
  organization_id: string,
  currentDepth: number = 0
) {
  try {
    // Add early depth check
    if (currentDepth >= max_depth) {
      console.log(`Reached maximum depth (${max_depth}) for ${base_url}`);
      return [];
    }

    const normalizedBaseUrl = normalizeUrl(base_url);
    const baseUrlObj = new URL(normalizedBaseUrl);

    // Skip invalid URLs early
    if (!isValidUrl(normalizedBaseUrl)) {
      console.log(`Skipping invalid or search URL: ${normalizedBaseUrl}`);
      return [];
    }

    // Check if URL was already processed in this session
    if (processedUrlsCache.has(normalizedBaseUrl)) {
      console.log(
        `Skipping already processed URL in this session: ${normalizedBaseUrl}`
      );
      return [];
    }

    const urlId = crypto
      .createHash("sha256")
      .update(normalizedBaseUrl)
      .digest("hex");

    // Check database status
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

    if (status === ProcessingStatus.COMPLETED) {
      console.log(`${base_url} was previously processed - skipping`);
      processedUrlsCache.add(normalizedBaseUrl); // Add to cache
    }

    // Add to processed cache before processing
    processedUrlsCache.add(normalizedBaseUrl);

    console.log(`Crawling: ${base_url}`);

    try {
      console.log(`Updating processing status for ${base_url}`);
      await updateProcessingStatus(
        urlId,
        base_url,
        ProcessingStatus.PROCESSING,
        organization_id
      );

      console.log(`Starting scrape for ${base_url}`);
      const { bodyText, links } = await scrape_website(base_url);
      console.log(
        `Scraped content for ${base_url}, content length: ${bodyText.length}`
      );

      // Only filter and process content if it hasn't been processed before
      if (status !== ProcessingStatus.COMPLETED) {
        console.log(`Starting content filtering for ${base_url}`);
        const filtered_content = await filter_content(bodyText);
        console.log(
          `Filtered content for ${base_url}, filtered length: ${
            filtered_content?.length || 0
          }`
        );

        if (filtered_content) {
          console.log(
            `Starting document processing for ${base_url}`,
            filtered_content
          );
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

          const batchPromise = Promise.all(
            batch
              .map((link) => {
                // Normalize the link
                if (link.startsWith("/")) {
                  link = new URL(link, normalizedBaseUrl).toString();
                }
                const normalizedLink = normalizeUrl(link);

                // Process if:
                // 1. Link is from the same domain as base_url
                // 2. Not already processed
                // 3. Within depth limit
                if (
                  normalizedLink.includes(baseUrlObj.hostname) &&
                  !processedUrls.has(normalizedLink) &&
                  currentDepth < max_depth &&
                  isValidUrl(normalizedLink)
                ) {
                  processedUrls.add(normalizedLink);
                  console.log(
                    `Crawling new link: ${normalizedLink} at depth ${
                      currentDepth + 1
                    }`
                  );

                  return crawlQueue.add(async () => {
                    const singleCrawlPromise = withRetry(
                      async () => {
                        return crawl_website(
                          normalizedLink,
                          max_depth,
                          organization_id,
                          currentDepth + 1
                        );
                      },
                      {
                        maxRetries: 2,
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
                } else {
                  console.log(`Skipping link: ${normalizedLink}`);
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
          console.error(
            `[Depth ${currentDepth}] Batch processing error:`,
            error
          );
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
    const cleaned_content = cleanedCodeContent.replace(/\n/g, "");
    const hash = crypto
      .createHash("sha256")
      .update(normalizedUrl)
      .digest("hex");
    const embeddings = await generateEmbeddingWithRetry(cleaned_content);

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
                cleaned_content,
                url,
                embeddings,
              ]
            );
            console.log(`Inserted document single: ${normalizedUrl}`, res.rows);
            return res.rows.length > 0;
          });
        });
      });
      console.log(`Processed document single: ${normalizedUrl}`, result);
      return result === true;
    } else {
      // Multiple chunks case
      const chunks = splitTextIntoChunks(cleaned_content, MAX_TOKENS);
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
                console.log(
                  `Inserted document chunk: ${normalizedUrl}`,
                  res.rows
                );
                return res.rows.length > 0;
              });
            });
          })
        )
      );
      console.log(`Processed document chunks: ${normalizedUrl}`, results);
      return results.every(
        (result: any) => result.status === "fulfilled" && result.value !== null
      );
    }
  } catch (error) {
    console.error("Fatal error in processDocument:", error);
    return false;
  }
}
