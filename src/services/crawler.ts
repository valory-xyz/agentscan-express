import { chromium, Browser } from "playwright";
import { toSql } from "pgvector";
import PQueue from "p-queue";
import * as crypto from "crypto";
import openai from "../initalizers/openai";
import { estimateTokens, MAX_TOKENS, splitTextIntoChunks } from "./openai";
import { executeQuery, safeQueueOperation } from "./postgres";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import fetch from "node-fetch";
import pdf from "pdf-parse";
import { Octokit } from "@octokit/rest";
import * as base64 from "base-64";
import pgvector from "pgvector";
import { YoutubeTranscript } from "youtube-transcript";
import { google } from "googleapis";
import { JSDOM } from "jsdom";

// Simplify the status enum
enum ProcessingStatus {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
}

// Add type definition near the top with other enums/types
type ContextType = "video" | "document" | "code";

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

// Add a crawling queue to limit concurrent page scraping
const crawlQueue = new PQueue({
  concurrency: 2, // Reduced for Railway
  interval: 5000, // Increased interval
});

// Add these timeout constants at the top
const TIMEOUTS = {
  PAGE_LOAD: 30000, // 30 seconds for initial page load
  _OPERATION: 45000, // 45 seconds for scraping content
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

// Add X-related constants
const X_TIMEOUTS = {
  NORMAL: 30000, // 30 seconds for scraping X post
  PROCESS: 45000, // 45 seconds for processing content
};

// Cache for embeddings
const embeddingCache = new Map<string, number[]>();

// Modified generateEmbeddingWithRetry function
export async function generateEmbeddingWithRetry(
  text: string,
  maxRetries: number = 3,
  initialDelay: number = 200
): Promise<any> {
  const estimatedTokens = estimateTokens(text);

  // If text is within token limit, proceed normally
  if (estimatedTokens <= MAX_TOKENS) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const cleanedText = text.replace(/[\r\n]/g, " ");
        const embeddingResponse = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: cleanedText,
          dimensions: 512,
        });

        return pgvector.toSql(embeddingResponse.data?.[0]?.embedding);
      } catch (error: any) {
        // If we hit the token limit, break out of retry loop and handle splitting
        if (
          error.status === 400 &&
          error.message?.includes("maximum context length")
        ) {
          break;
        }

        if (attempt === maxRetries) {
          console.error(
            "Failed all retry attempts for embedding generation:",
            error
          );
          throw error;
        }

        const delay =
          initialDelay * Math.pow(1.5, attempt - 1) + Math.random() * 100;
        console.log(
          `Embedding generation attempt ${attempt} failed. Retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Split text into chunks
  console.log("Text too long for single embedding, splitting into chunks...");
  const chunks = splitTextIntoChunks(text, MAX_TOKENS);

  // Process each chunk
  const embeddings: any[] = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`Processing chunk ${i + 1}/${chunks.length}`);
    try {
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: chunks[i] as string,
        dimensions: 512,
      });

      embeddings.push(pgvector.toSql(embeddingResponse.data?.[0]?.embedding));
    } catch (error) {
      console.error(`Failed to generate embedding for chunk ${i + 1}:`, error);
      throw error;
    }
  }

  return embeddings;
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
interface dContent {
  bodyText: string;
  links: string[];
  title?: string;
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

    // Add GitHub repository detection
    if (
      url.startsWith("https://github.com/") &&
      url.split("/").length >= 3 &&
      !url.includes("/blob/")
    ) {
      return true;
    }

    // Add YouTube URL detection
    if (url.includes("youtube.com/watch?v=") || url.includes("youtu.be/")) {
      return true;
    }

    // Add X.com and Twitter.com URL detection
    if (
      (url.includes("twitter.com/") || url.includes("x.com/")) &&
      url.includes("/status/")
    ) {
      return true;
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

// Update the browser launch options
const BROWSER_LAUNCH_OPTIONS = {
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-extensions",
    "--no-first-run",
    "--no-service-autorun",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-gl=swiftshader",
    "--enable-webgl",
    "--disable-translate",
  ],
  executablePath: process.env.CHROME_BIN || undefined,
  ignoreDefaultArgs: ["--disable-extensions"],
};

// Update the getBrowser function
async function getBrowser(): Promise<Browser> {
  try {
    if (!browserInstance) {
      console.log(
        "Launching new browser instance with custom configuration..."
      );
      browserInstance = await chromium.launch(BROWSER_LAUNCH_OPTIONS);
    }
    return browserInstance;
  } catch (error) {
    console.error("Failed to launch browser:", error);
    // Fallback to basic configuration if initial launch fails
    const fallbackOptions = {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
      ignoreHTTPSErrors: true,
    };
    console.log("Attempting fallback launch configuration...");
    browserInstance = await chromium.launch(fallbackOptions);
    return browserInstance;
  }
}

// Add this constant near other constants
const youtube = google.youtube({
  version: "v3",
  auth: process.env.YOUTUBE_API_KEY, // You'll need to add this to your env variables
});

// Update the getYoutubeVideoId function to also fetch the title
async function getYoutubeVideoInfo(
  url: string
): Promise<{ videoId: string | null; title: string | null }> {
  try {
    const urlObj = new URL(url);
    let videoId = null;

    if (urlObj.hostname.includes("youtube.com")) {
      videoId = urlObj.searchParams.get("v");
    } else if (urlObj.hostname === "youtu.be") {
      videoId = urlObj.pathname.slice(1);
    }

    if (!videoId) {
      return { videoId: null, title: null };
    }

    // Fetch video title using YouTube Data API
    try {
      const response = await youtube.videos.list({
        part: ["snippet"],
        id: [videoId],
      });

      const title = response.data.items?.[0]?.snippet?.title || null;
      return { videoId, title };
    } catch (error) {
      console.error("Error fetching video title:", error);
      return { videoId, title: null };
    }
  } catch {
    return { videoId: null, title: null };
  }
}

// Update the transcribeYoutubeVideo function to use filter_youtube_content
async function transcribeYoutubeVideo(
  url: string,
  organization_id: string
): Promise<{ transcript: string; title: string | null }> {
  const urlId = crypto.createHash("sha256").update(url).digest("hex");
  try {
    const { videoId, title } = await getYoutubeVideoInfo(url);
    if (!videoId) {
      throw new Error("Invalid YouTube URL");
    }

    // Check if video was already processed
    const status = await dbQueue.add(async () => {
      const result = await executeQuery(async (client) => {
        const res = await client.query(
          `SELECT status FROM context_processing_status 
           WHERE id = $1 AND type = 'video' AND company_id = $2`,
          [urlId, organization_id]
        );
        return res.rows[0]?.status;
      });
      return result;
    });

    if (status === ProcessingStatus.COMPLETED) {
      console.log(`YouTube video ${url} was previously processed - skipping`);
      return { transcript: "", title }; // Return empty transcript to skip processing
    }

    // Update status to processing
    await updateProcessingStatus(
      urlId,
      url,
      ProcessingStatus.PROCESSING,
      organization_id,
      "video"
    );

    console.log(
      `Transcribing YouTube video: ${videoId} - ${title || "Unknown Title"}`
    );
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);

    // Combine all transcript parts into a single text
    const fullText = transcript
      .map((part) => part.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!fullText || fullText.length < 50) {
      throw new Error("Transcript too short or empty");
    }

    // Filter the content using the specialized YouTube filter
    const filteredContent = await filter_youtube_content(fullText);

    // Format the transcript with the title
    const formattedTranscript = title
      ? `Title: ${title}\n${filteredContent || fullText}`
      : filteredContent || fullText;

    // Update status to completed
    await updateProcessingStatus(
      urlId,
      url,
      ProcessingStatus.COMPLETED,
      organization_id,
      "video"
    );

    return { transcript: formattedTranscript, title };
  } catch (error: any) {
    console.error("Error transcribing YouTube video:", error);

    // Update status to failed
    await updateProcessingStatus(
      urlId,
      url,
      ProcessingStatus.FAILED,
      organization_id,
      error.message,
      "video"
    );

    throw error;
  }
}

// Update the _website function's YouTube handling section
async function _website(
  url: string,
  organization_id: string
): Promise<dContent> {
  let browser: any = null;
  let context: any = null;
  let page: any = null;

  try {
    // Handle X/Twitter posts
    if (
      (url.includes("twitter.com") || url.includes("x.com")) &&
      url.includes("/status/")
    ) {
      console.log(`Detected X post URL: ${url}`);
      const { content } = await XPost(url);
      return {
        bodyText: content,
        links: [],
      };
    }

    // Handle YouTube case first
    if (url.includes("youtube.com/watch?v=") || url.includes("youtu.be/")) {
      console.log(`Detected YouTube URL: ${url}`);
      const { transcript, title } = await transcribeYoutubeVideo(
        url,
        organization_id
      );
      return {
        bodyText: transcript,
        links: [],
        title: title || url,
      };
    }

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
          console.log(`Starting  for ${url}`);
          // Launch a new browser instance for each
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
                TIMEOUTS._OPERATION
              )
            ),
          ])) as dContent;

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
    console.error("Fatal error in _website:", error);
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
  errorMessage?: string,
  type: "document" | "code" | "video" = "document"
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
              type,
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
            [urlId, organization_id, type, status, errorMessage || null]
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

// Add GitHub API configuration
const octokit = new Octokit({
  auth: process.env.GITHUB_ACCESS_TOKEN, // You'll need to add this to your env variables
});

// Add supported file extensions
const SUPPORTED_EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".java",
  ".go",
  ".cpp",
  ".c",
  ".h",
  ".cs",
  ".php",
  ".swift",
  ".kt",
  ".rs",
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".sol",
  ".pdf",
  ".rs",
];

// Update these constants for GitHub rate limiting
const GITHUB_RATE_LIMIT = {
  WAIT_BUFFER: 1800000, // 3 minutes buffer after reset time
  MAX_WAIT_TIME: 7200000, // 2 hours maximum wait time
};

// Update the GitHub rate limit handling function
async function handleGitHubRateLimit(error: any): Promise<void> {
  if (error.status === 403 && error.response?.headers?.["x-ratelimit-reset"]) {
    const resetTimeSeconds = parseInt(
      error.response.headers["x-ratelimit-reset"]
    );
    if (!isNaN(resetTimeSeconds)) {
      const resetTimeMs = resetTimeSeconds * 1000; // Convert seconds to milliseconds
      const now = Date.now();
      const waitTime = Math.min(
        resetTimeMs - now + GITHUB_RATE_LIMIT.WAIT_BUFFER,
        GITHUB_RATE_LIMIT.MAX_WAIT_TIME
      );

      if (waitTime > 0) {
        console.log(
          `GitHub rate limit hit. Waiting ${Math.round(
            waitTime / 1000
          )} seconds until ${new Date(resetTimeMs).toISOString()}`
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        return;
      }
    }
  }
  throw error; // Re-throw if not a rate limit error or invalid reset time
}

// Update GitHub repository processing function
async function processGithubRepo(
  repoUrl: string,
  organization_id: string,
  contextType: ContextType | null = null
): Promise<boolean> {
  const urlId = crypto.createHash("sha256").update(repoUrl).digest("hex");

  try {
    // Check if repository was already processed
    const status = await dbQueue.add(async () => {
      const result = await executeQuery(async (client) => {
        const res = await client.query(
          `SELECT status FROM context_processing_status 
           WHERE id = $1 AND type = $2 AND company_id = $3`,
          [urlId, contextType || "code", organization_id]
        );
        return res.rows[0]?.status;
      });
      return result;
    });

    if (status === ProcessingStatus.COMPLETED) {
      console.log(
        `GitHub repository ${repoUrl} was previously processed - skipping`
      );
      return true;
    }

    // Update status to processing
    await updateProcessingStatus(
      urlId,
      repoUrl,
      ProcessingStatus.PROCESSING,
      organization_id,
      undefined,
      contextType || "code"
    );

    // Extract owner and repo from GitHub URL
    const urlParts = repoUrl.replace("https://github.com/", "").split("/");
    const owner = urlParts[0];
    const repo = urlParts[1];

    console.log(`Processing GitHub repository: ${owner}/${repo}`);

    // Get repository contents with rate limit handling
    let contents;
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: "",
      });
      contents = data;
    } catch (error: any) {
      if (error.status === 403) {
        await handleGitHubRateLimit(error);
        // Retry the initial content fetch after waiting
        const { data } = await octokit.repos.getContent({
          owner,
          repo,
          path: "",
        });
        contents = data;
      } else {
        throw error;
      }
    }

    const processFile = async (
      file: any,
      path: string = ""
    ): Promise<boolean> => {
      try {
        // Skip files with 'audits' in the name or path
        const fullPath = path ? `${path}/${file.name}` : file.name;
        if (fullPath.toLowerCase().includes("audits")) {
          console.log(`Skipping audit-related file: ${fullPath}`);
          return true;
        }

        if (
          !SUPPORTED_EXTENSIONS.some((ext) =>
            file.name.toLowerCase().endsWith(ext)
          )
        ) {
          return true;
        }

        try {
          const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: path ? `${path}/${file.name}` : file.name,
          });

          // Type check and access content safely
          if (!("content" in data) || typeof data.content !== "string") {
            throw new Error("Invalid file content response");
          }

          const fileUrl = `${repoUrl}/blob/main/${path}/${file.name}`;

          // Handle PDF files differently
          if (file.name.toLowerCase().endsWith(".pdf")) {
            // Get raw PDF URL
            const rawPdfUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}/${file.name}`;
            console.log(`Processing PDF file from GitHub: ${rawPdfUrl}`);

            try {
              const pdfText = await downloadAndProcessPdf(rawPdfUrl);
              const filteredContent = await filter_pdf_content(pdfText);
              return await processDocument(
                fileUrl,
                filteredContent || pdfText,
                organization_id,
                undefined,
                contextType
              );
            } catch (pdfError) {
              console.error(
                `Error processing PDF file ${file.name}:`,
                pdfError
              );
              return false;
            }
          }

          // Process non-PDF files
          const content = base64.decode(data.content);
          return await processDocument(
            fileUrl,
            content,
            organization_id,
            undefined,
            contextType
          );
        } catch (error: any) {
          if (error.status === 403) {
            await handleGitHubRateLimit(error);

            return await processFile(file, path);
          }
          throw error;
        }
      } catch (error: any) {
        console.error(`Error processing file ${file.name}:`, error);
        return false;
      }
    };

    const processDirectory = async (dirPath: string): Promise<void> => {
      try {
        // Skip directories with 'audits' in the path
        if (dirPath.toLowerCase().includes("audits")) {
          console.log(`Skipping audit-related directory: ${dirPath}`);
          return;
        }

        const { data: dirContents } = await octokit.repos.getContent({
          owner,
          repo,
          path: dirPath,
        });

        for (const item of Array.isArray(dirContents)
          ? dirContents
          : [dirContents]) {
          if (item.type === "file") {
            await processFile(item, dirPath);
          } else if (item.type === "dir") {
            await processDirectory(`${dirPath}/${item.name}`);
          }
        }
      } catch (error: any) {
        if (error.status === 403) {
          await handleGitHubRateLimit(error);
          // Retry the same directory after waiting
          return processDirectory(dirPath);
        }
        throw error;
      }
    };

    // Process all contents
    for (const item of Array.isArray(contents) ? contents : [contents]) {
      if (item.type === "file") {
        await processFile(item);
      } else if (item.type === "dir") {
        await processDirectory(item.name);
      }
    }

    // Update status to completed at the end
    await updateProcessingStatus(
      urlId,
      repoUrl,
      ProcessingStatus.COMPLETED,
      organization_id,
      undefined,
      contextType || "code"
    );

    return true;
  } catch (error: any) {
    console.error("Error processing GitHub repository:", error);

    // Update status to failed
    await updateProcessingStatus(
      urlId,
      repoUrl,
      ProcessingStatus.FAILED,
      organization_id,
      error.message,
      contextType || "code"
    );

    return false;
  }
}

// Update crawl_website to better handle X posts
export async function crawl_website(
  base_url: string,
  max_depth: number = 7,
  organization_id: string,
  contextType: ContextType | null = null,
  currentDepth: number = 0
) {
  try {
    // Handle X/Twitter posts first and return immediately
    if (base_url.includes("x.com") || base_url.includes("twitter.com")) {
      if (base_url.includes("/status/")) {
        // This is a single tweet URL
        console.log(`Processing single X post: ${base_url}`);
        const { content } = await XPost(base_url);
        if (content) {
          await processDocument(
            base_url,
            content,
            organization_id,
            undefined,
            contextType as ContextType
          );
        }
      } else {
        // This is a user profile URL
        const username = base_url.split("/").pop()?.replace("@", "");
        if (username) {
          console.log(`Processing X account: ${username}`);
          await processXAccount(
            username,
            organization_id,
            undefined,
            contextType as ContextType
          );
        }
      }
      // Return empty array to prevent further crawling
      return [];
    }

    // Add GitHub repository handling
    if (
      base_url.startsWith("https://github.com/") &&
      base_url.split("/").length >= 3 &&
      !base_url.includes("/blob/")
    ) {
      console.log("Processing GitHub repository:", base_url);
      await processGithubRepo(base_url, organization_id, contextType);
      return [];
    }

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
        organization_id,
        undefined,
        "document"
      );

      console.log(`Starting  for ${base_url}`);
      const { bodyText, links, title } = await _website(
        base_url,
        organization_id
      );
      console.log(
        `d content for ${base_url}, content length: ${bodyText.length}`
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
            organization_id,
            title,
            contextType
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
            success ? undefined : "Failed to process document",
            "document"
          );
        } else {
          console.log(`No filtered content produced for ${base_url}`);
          await updateProcessingStatus(
            urlId,
            base_url,
            ProcessingStatus.FAILED,
            organization_id,
            "No content after filtering",
            "document"
          );
        }
      }

      const processedUrls = new Set();
      console.log(
        `Processing ${links.length} links from ${base_url} (depth: ${max_depth})`
      );

      // Add early return if no links to process
      if (links.length === 0) {
        console.log(`No links to process for ${base_url}, returning early`);
        return [];
      }

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
                          contextType,
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
        error.message,
        "code"
      );
      return [];
    }
  } catch (error) {
    console.error("Fatal error in crawl_website:", error);
    return []; // Return empty array instead of crashing
  }
}

// Update processDocument function to simplify YouTube content structure
async function processDocument(
  url: string,
  cleanedCodeContent: string,
  organization_id: string,
  title?: string,
  contextType?: ContextType | null
): Promise<boolean> {
  try {
    const normalizedUrl = normalizeUrl(url);
    console.log(`Processing document: ${normalizedUrl}`);
    const urlId = crypto
      .createHash("sha256")
      .update(normalizedUrl)
      .digest("hex");

    // Determine the type based on the URL or use provided contextType
    const type: ContextType =
      contextType ||
      (url.includes("youtube.com") || url.includes("youtu.be")
        ? "video"
        : url.includes("github.com")
        ? "code"
        : url.includes("x.com") || url.includes("twitter.com")
        ? "document"
        : "document");

    // For YouTube videos, format content with title prefix
    const cleaned_content =
      type === "video" && title
        ? `title: ${title}\n${cleanedCodeContent}`.replace(/\n/g, " ").trim()
        : cleanedCodeContent.replace(/\n/g, " ").trim();

    // Get embeddings and ensure they're properly formatted
    const embeddings = await generateEmbeddingWithRetry(cleaned_content);

    if (!Array.isArray(embeddings) || embeddings.length === 1) {
      // Single embedding case
      const formattedEmbedding = Array.isArray(embeddings)
        ? embeddings[0]
        : embeddings;

      if (!formattedEmbedding || typeof formattedEmbedding !== "string") {
        console.error("Invalid embedding format:", formattedEmbedding);
        return false;
      }

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
              ) VALUES ($1, $2, $3, $4, $5, $6, $7::vector, NOW(), NOW())
              ON CONFLICT (id, type, location) DO UPDATE SET
                content = EXCLUDED.content,
                name = EXCLUDED.name,
                embedding = EXCLUDED.embedding::vector,
                updated_at = NOW()
              RETURNING id`,
              [
                urlId,
                organization_id,
                type,
                url,
                cleaned_content,
                title || url,
                formattedEmbedding,
              ]
            );
            console.log(`Inserted ${type} single: ${normalizedUrl}`, res.rows);
            return res.rows.length > 0;
          });
        });
      });
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

            const formattedEmbedding = embeddings[i];
            if (!formattedEmbedding || typeof formattedEmbedding !== "string") {
              console.error(
                `Invalid embedding format for chunk ${i}:`,
                formattedEmbedding
              );
              return false;
            }

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
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9, NOW(), NOW())
                  ON CONFLICT (id, type, location) DO UPDATE SET
                    content = EXCLUDED.content,
                    name = EXCLUDED.name,
                    embedding = EXCLUDED.embedding::vector,
                    is_chunk = EXCLUDED.is_chunk,
                    original_location = EXCLUDED.original_location,
                    updated_at = NOW()
                  RETURNING id`,
                  [
                    chunkHash,
                    organization_id,
                    type,
                    chunkLocation,
                    chunk,
                    `${title || url} (Part ${i + 1})`,
                    formattedEmbedding,
                    true,
                    url,
                  ]
                );
                console.log(
                  `Inserted ${type} chunk: ${normalizedUrl}`,
                  res.rows
                );
                return res.rows.length > 0;
              });
            });
          })
        )
      );
      return results.every(
        (result) => result.status === "fulfilled" && result.value === true
      );
    }
  } catch (error) {
    console.error("Fatal error in processDocument:", error);
    return false;
  }
}

// Add this new function after filter_content
async function filter_youtube_content(transcript: string) {
  try {
    if (!transcript || transcript.length < 50) {
      console.log("Transcript too short, skipping filtering");
      return null;
    }

    const prompt = `
      You are a YouTube transcript specialist. Your task is to:
      1. Create a clear, well-structured summary of the video content
      2. Include:
         - Main topics and key points
         - Important insights or takeaways
         - Key examples or demonstrations
         - Relevant technical details
      3. Remove:
         - Advertisements
         - Sponsorship messages
         - Like/subscribe reminders
         - Redundant information
         - Filler words and phrases
      4. Format the output as clean, readable text
      5. Maintain technical accuracy while improving readability

      Return only the processed content, without any explanations.

      Content to process:
      
      ${transcript.slice(0, 84500).replace(/\n/g, " ")}
    `;

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

    const response = await filterPromise;

    if (!response?.choices?.[0]?.message?.content) {
      console.error("No response from OpenAI API for YouTube processing");
      return null;
    }

    const filtered_content = response.choices[0].message.content.trim();

    if (!filtered_content || filtered_content.length < 50) {
      console.warn("Filtered YouTube content seems too short or empty");
      return null;
    }

    return filtered_content;
  } catch (error) {
    console.error("Fatal error in filter_youtube_content:", error);
    return null;
  }
}

async function XPost(url: string): Promise<{ content: string; title: null }> {
  let browser = null;
  let page = null;

  try {
    browser = await getBrowser();
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    });

    page = await context.newPage();
    await page.setDefaultTimeout(X_TIMEOUTS.NORMAL);

    console.log(`Navigating to X post: ${url}`);
    await page.goto(url, { waitUntil: "networkidle" });

    // Wait for any of these selectors to be available
    const possibleSelectors = [
      'article[data-testid="tweet"]',
      '[data-testid="tweetText"]',
      ".css-1dbjc4n[lang]", // Alternative selector for tweet content
      'div[data-testid="tweet"] div[lang]', // Another alternative
    ];

    const content = await page.evaluate((selectors) => {
      // Try different methods to get the tweet content
      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          // Combine text content from all matching elements
          return Array.from(elements)
            .map((el) => el.textContent || "")
            .join("\n")
            .trim();
        }
      }

      // Fallback: try to find any element with tweet-like content
      const tweetContainer = document.querySelector('div[role="article"]');
      if (tweetContainer) {
        return tweetContainer.textContent || "";
      }

      return null;
    }, possibleSelectors);

    if (!content) {
      console.error("No tweet content found using any selector");
      throw new Error("Failed to extract tweet content");
    }

    // Clean up the content
    const cleanedContent = content
      .replace(/\s+/g, " ")
      .replace(/(?:https?|ftp):\/\/[\n\S]+/g, "")
      .trim();

    if (cleanedContent.length < 8) {
      throw new Error("Tweet content too short or empty after cleaning");
    }

    console.log(
      `Successfully extracted tweet content (${cleanedContent.length} chars)`
    );
    return {
      content: cleanedContent,
      title: null,
    };
  } catch (error) {
    console.error("Error scraping X post:", error);
    throw error;
  } finally {
    if (page) await page.close().catch(console.error);
  }
}

// Add these new interfaces at the top with other interfaces
interface XAccountPost {
  id: string;
  content: string;
  timestamp: string;
  url: string;
  title?: string;
}

interface XAccountResult {
  posts: XAccountPost[];
  username: string;
  error?: string;
}

// Add this new function
async function XAccount(
  username: string,
  maxPosts: number = 1000
): Promise<XAccountResult> {
  let browser = null;
  let page = null;

  try {
    browser = await getBrowser(); // Use shared browser instance

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    page = await context.newPage();

    // Clean username (remove @ if present)
    const cleanUsername = username.replace("@", "");
    const url = `https://x.com/${cleanUsername}`;

    console.log(`Navigating to X profile: ${url}`);
    await page.goto(url, { waitUntil: "networkidle" });

    // Wait for the timeline to load
    await page.waitForSelector('article[data-testid="tweet"]', {
      timeout: 30000,
    });

    const posts: XAccountPost[] = [];
    let lastHeight = 0;
    let noNewPostsCount = 0;
    const maxScrollAttempts = 50; // Increase scroll attempts
    let scrollAttempts = 0;

    while (posts.length < maxPosts && scrollAttempts < maxScrollAttempts) {
      scrollAttempts++;

      // Extract posts currently visible
      const newPosts = await page.evaluate((username) => {
        return Array.from(
          document.querySelectorAll('article[data-testid="tweet"]')
        )
          .map((article) => {
            const link =
              article
                .querySelector('a[href*="/status/"]')
                ?.getAttribute("href") || "";

            // Only process if it's a valid tweet URL AND it's from the target user
            if (
              !link ||
              !link.includes("/status/") ||
              !link.startsWith(`/${username}`)
            ) {
              return null;
            }

            const tweetText =
              article.querySelector('[data-testid="tweetText"]')?.textContent ||
              "";
            const timestamp =
              article.querySelector("time")?.getAttribute("datetime") || "";
            const id = link.split("/status/")[1] || "";

            const possibleHeadings = Array.from(
              article.querySelectorAll("span")
            ).filter(
              (span) =>
                span.style.fontSize === "23px" || span.style.fontSize === "20px"
            );
            const title =
              possibleHeadings.length > 0
                ? possibleHeadings[0].textContent
                : undefined;

            return {
              id,
              content: tweetText,
              timestamp,
              url: `https://x.com${link}`,
              title: title || undefined,
            };
          })
          .filter((post) => post !== null);
      }, cleanUsername);

      // Track how many new posts we found
      const initialPostCount = posts.length;

      // Add new unique posts
      for (const post of newPosts) {
        if (!posts.some((p) => p.id === post.id) && post.id) {
          posts.push(post);
        }
      }

      // Check if we found any new posts
      if (posts.length === initialPostCount) {
        noNewPostsCount++;
        if (noNewPostsCount >= 5) {
          // If no new posts found after 5 attempts, break
          console.log("No new posts found after multiple scroll attempts");
          break;
        }
      } else {
        noNewPostsCount = 0; // Reset counter if we found new posts
      }

      console.log(`Found ${posts.length} posts so far...`);
      //preview the last post
      console.log(posts[posts.length - 1].content);

      // Scroll down with a more reliable method
      await page.evaluate(() => {
        const distance = 800; // Scroll by 800px each time
        window.scrollBy(0, distance);
      });

      // Add a longer wait time for content to load
      await page.waitForTimeout(2000);

      // Check if we've reached the bottom
      const newHeight = await page.evaluate(() => document.body.scrollHeight);
      if (newHeight === lastHeight) {
        noNewPostsCount++;
        if (noNewPostsCount >= 5) {
          console.log("Reached bottom of page");
          break;
        }
      }
      lastHeight = newHeight;
    }

    console.log(`Finished scraping with ${posts.length} posts collected`);
    return {
      posts: posts.slice(0, maxPosts),
      username: cleanUsername,
    };
  } catch (error: any) {
    console.error("Error scraping X account:", error);
    return {
      posts: [],
      username: username,
      error: error?.message,
    };
  } finally {
    if (page) await page.close().catch(console.error);
    // Don't close browser here, let it be managed by getBrowser
  }
}

// Update the processXAccount function to use batches
export async function processXAccount(
  username: string,
  organization_id: string,
  maxPosts: number = 1000,
  contextType: string | null = null
): Promise<boolean> {
  try {
    console.log(`Processing X account: ${username}`);
    const result = await XAccount(username, maxPosts);
    console.log(`d ${result.posts.length} posts from ${username}`);

    if (result.error || result.posts.length === 0) {
      console.error(`Failed to  X account ${username}:`, result.error);
      return false;
    }

    // Process posts in batches of 4
    const BATCH_SIZE = 4;
    const batches = [];
    for (let i = 0; i < result.posts.length; i += BATCH_SIZE) {
      batches.push(result.posts.slice(i, i + BATCH_SIZE));
    }

    let successCount = 0;
    let batchNumber = 1;

    for (const batch of batches) {
      console.log(
        `Processing batch ${batchNumber}/${batches.length} for ${username}`
      );

      const batchPromises = batch.map(async (post) => {
        const urlId = crypto
          .createHash("sha256")
          .update(post.url)
          .digest("hex");

        try {
          await updateProcessingStatus(
            urlId,
            post.url,
            ProcessingStatus.PROCESSING,
            organization_id,
            undefined,
            "document"
          );

          // Get full post content using existing XPost
          const { content } = await XPost(post.url);

          if (content) {
            await processDocument(
              post.url,
              content,
              organization_id,
              post.title,
              contextType as ContextType
            );
            await updateProcessingStatus(
              urlId,
              post.url,
              ProcessingStatus.COMPLETED,
              organization_id,
              undefined,
              "document"
            );
            return true;
          }
          return false;
        } catch (error: any) {
          console.error(`Error processing X post ${post.url}:`, error);
          await updateProcessingStatus(
            urlId,
            post.url,
            ProcessingStatus.FAILED,
            organization_id,
            error?.message,
            "document"
          );
          return false;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      const batchSuccesses = batchResults.filter(Boolean).length;
      successCount += batchSuccesses;

      console.log(
        `Batch ${batchNumber}/${batches.length}: Processed ${batchSuccesses}/${BATCH_SIZE} posts successfully`
      );

      // Add a small delay between batches
      if (batchNumber < batches.length) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      batchNumber++;
    }

    console.log(
      `Completed processing ${username}: ${successCount}/${result.posts.length} posts processed successfully`
    );
    return successCount > 0;
  } catch (error) {
    console.error(`Error processing X account ${username}:`, error);
    return false;
  }
}
