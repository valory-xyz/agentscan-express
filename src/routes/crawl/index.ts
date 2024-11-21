import express from "express";
import { crawl_website } from "../../services/crawler";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { url: rawUrl, maxDepth = 20, organization_id } = req.body;

    if (!rawUrl || !organization_id) {
      return res
        .status(400)
        .json({ error: "URL and organization_id are required" });
    }

    // Remove trailing slash from URL
    const url = rawUrl.replace(/\/$/, "");

    // Start crawling in the background
    crawl_website(url, maxDepth, organization_id).catch((error) => {
      console.error("Crawling failed:", error);
    });

    return res.json({
      message: "Crawling started successfully",
      url,
    });
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to start crawling",
      message: error.message,
    });
  }
});

export default router;
