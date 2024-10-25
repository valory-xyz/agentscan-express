import OpenAI from "openai";

import dotenv from "dotenv";

dotenv.config();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPEN_API_KEY, // Make sure to set this in your environment variables
});

export default openai;
