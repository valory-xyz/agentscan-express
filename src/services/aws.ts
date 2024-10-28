import { PutObjectCommand } from "@aws-sdk/client-s3";
import s3Client from "../initalizers/aws";
import { v4 as uuidv4 } from "uuid";
// Helper function to upload a single file to S3
export async function uploadFileToS3(file: any): Promise<string> {
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
