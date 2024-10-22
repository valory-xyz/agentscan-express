import { Router } from "express";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";

const router = Router();

// Configure S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

// Helper function to upload a single file to S3
async function uploadFileToS3(file: Express.Multer.File): Promise<string> {
  const fileKey = `chat-images/${uuidv4()}-${file.originalname}`;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype,
    })
  );
  return `https://${process.env.S3_BUCKET_NAME}.s3.amazonaws.com/${fileKey}`;
}

// Configure multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Route to handle file uploads
router.post("/", upload.array("images", 2), async (req: any, res) => {
  const userId = req.user?.id; // Retrieve user ID from authenticated request
  const files = req.files as Express.Multer.File[];

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  if (!files || files.length === 0) {
    return res.status(400).json({ message: "No files uploaded" });
  }

  try {
    const uploadPromises = files.map((file) => uploadFileToS3(file));
    const uploadedUrls = await Promise.all(uploadPromises);

    const embeds = uploadedUrls.map((url) => ({
      type: "image",
      image: url,
    }));

    res.json({ embeds });
  } catch (error) {
    console.error("Error uploading files:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
