import { Router } from "express";
import multer from "multer";
import { uploadFileToS3 } from "../../services/aws";

const router = Router();

// Configure multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Route to handle file uploads
router.post("/", upload.array("image", 1), async (req: any, res) => {
  const userId = req.user?.id; // Retrieve user ID from authenticated request
  console.log(req.files);
  const files: any[] = req.files as any[];

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  if (!files || files.length === 0) {
    return res.status(400).json({ message: "No files uploaded" });
  }

  try {
    const uploadPromises = files.map((file) => uploadFileToS3(file));
    const uploadedUrls = await Promise.all(uploadPromises);
    if (uploadedUrls.length === 0) {
      return res.status(500).json({ message: "Internal server error" });
    }

    const embeds = uploadedUrls.map((url) => ({
      type: "image",
      image: url,
    }));
    console.log(embeds);
    res.json({ embeds });
  } catch (error) {
    console.log("Error uploading files:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
