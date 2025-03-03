import express from "express";
import { crawl_website } from "../../services/crawler";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    return res.status(400).json({
      message: "Crawling is disabled",
    });
    const {
      urls: rawUrls,
      maxDepth = 7,
      organization_id,
      type = null,
    } = req.body;

    if (!rawUrls || !organization_id) {
      return res
        .status(400)
        .json({ error: "URLs and organization_id are required" });
    }

    // Split URLs by comma and trim whitespace
    const urls = rawUrls
      .split(",")
      .map((url: string) => url.trim().replace(/\/$/, ""))
      .filter((url: string) => url.length > 0);

    if (urls.length === 0) {
      return res.status(400).json({ error: "No valid URLs provided" });
    }

    // Start crawling each URL in the background with the optional type
    urls.forEach((url: string) => {
      crawl_website(url, maxDepth, organization_id, type).catch((error) => {
        console.error(`Crawling failed for ${url}:`, error);
      });
    });

    return res.json({
      message: "Crawling started successfully",
      urls,
    });
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to start crawling",
      message: error.message,
    });
  }
});

export default router;
