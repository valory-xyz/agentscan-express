import OpenAI from "openai";

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPEN_API_KEY, // Make sure to set this in your environment variables
});

export default openai;
