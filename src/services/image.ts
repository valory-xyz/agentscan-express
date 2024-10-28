import Replicate from "replicate";
import { uploadFileToS3 } from "./aws";
import openai from "../initalizers/openai";
import { ReadableStream } from "stream/web";
import { TextDecoder } from "util";

// Add this near your other imports
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

const MAX_RETRIES = 20;
const INITIAL_DELAY = 1000; // 1 second

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function generateImagePrompt(
  currentContent: string,
  biome: string
) {
  const prompt = `
  Convert this story scene into a simple image prompt.
  Scene: ${currentContent}
  Environment: ${biome}

  Rules:
  - Start with: cinematic shot
  - List main characters as simple objects/creatures
  - Use basic actions (standing, fighting, facing)
  - End with: dramatic lighting, 8k detailed
  - Maximum 15 words total
  - No complex descriptions or emotions
  
  Example:
  Input: "DUOLINGO THE BIRD and BOOP faced off against the angry child in the jungle"
  Output: cinematic shot, green owl and robot facing angry child, jungle setting, dramatic lighting, 8k detailed

  Respond with only the prompt.`.trim();

  const response = await openai.chat.completions.create({
    model: "chatgpt-4o-latest",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 60,
    temperature: 0.5,
  });
  console.log("response message", response.choices[0].message.content);

  return response.choices[0].message.content?.trim() || "";
}

export async function generateAndUploadImage(
  prompt: string,
  retryCount = 0
): Promise<string | undefined> {
  try {
    const input = {
      steps: 50,
      width: 1024,
      height: 1024,
      prompt,
      guidance: 3,
      interval: 2,
      aspect_ratio: "1:1",
      output_format: "jpg",
      output_quality: 80,
      prompt_upsampling: false,
      negative_prompt:
        "text, watermark, logo, signature, blurry, distorted, low quality",
    };

    console.log(`Attempt ${retryCount + 1} of ${MAX_RETRIES + 1}`);
    console.log("input", input);
    console.log("prompt", prompt);

    const output = await replicate.run("black-forest-labs/flux-pro", { input });
    console.log("output", output);

    // Handle ReadableStream response
    if (output instanceof ReadableStream) {
      const reader = output.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const buffer = Buffer.concat(chunks);
      const mockFile = {
        buffer,
        originalname: `story-${Date.now()}.jpg`,
        mimetype: "image/jpg",
      };

      const s3Url = await uploadFileToS3(mockFile);
      console.log("s3Url", s3Url);
      return s3Url;
    }

    throw new Error("Output was not a ReadableStream");
  } catch (error) {
    console.error(`Error on attempt ${retryCount + 1}:`, error);

    if (retryCount < MAX_RETRIES) {
      const backoffDelay = INITIAL_DELAY * Math.pow(2, retryCount);
      console.log(`Retrying in ${backoffDelay}ms...`);
      await delay(backoffDelay);
      return await generateAndUploadImage(prompt, retryCount + 1);
    }

    console.error("Max retries reached. Giving up.");
    return undefined;
  }
}

export async function generateAndUploadGIF(
  prompt: string,
  retryCount = 0
): Promise<string | undefined> {
  try {
    const input = {
      mp4: false,
      seed: Math.floor(Math.random() * 10000), // Random seed for variation
      steps: 40,
      width: 672,
      height: 384,
      prompt,
      scheduler: "EulerAncestralDiscreteScheduler",
      negative_prompt: "blurry, low quality, text, watermark, logo, signature",
    };

    console.log(`Attempt ${retryCount + 1} of ${MAX_RETRIES + 1}`);
    console.log("input", input);
    console.log("prompt", prompt);

    const output = await replicate.run(
      "lucataco/hotshot-xl:78b3a6257e16e4b241245d65c8b2b81ea2e1ff7ed4c55306b511509ddbfd327a",
      { input }
    );
    console.log("output", output);

    // Handle ReadableStream response
    if (output instanceof ReadableStream) {
      const reader = output.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const buffer = Buffer.concat(chunks);
      const mockFile = {
        buffer,
        originalname: `story-gif-${Date.now()}.gif`,
        mimetype: "image/gif",
      };

      const s3Url = await uploadFileToS3(mockFile);
      console.log("s3Url", s3Url);
      return s3Url;
    }

    throw new Error("Output was not a ReadableStream");
  } catch (error) {
    console.error(`Error on attempt ${retryCount + 1}:`, error);

    if (retryCount < MAX_RETRIES) {
      const backoffDelay = INITIAL_DELAY * Math.pow(2, retryCount);
      console.log(`Retrying in ${backoffDelay}ms...`);
      await delay(backoffDelay);
      return await generateAndUploadGIF(prompt, retryCount + 1);
    }

    console.error("Max retries reached. Giving up.");
    return undefined;
  }
}
