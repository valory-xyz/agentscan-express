import { config } from "../config";
import * as amplitude from "@amplitude/analytics-node";
import dotenv from "dotenv";

dotenv.config();

const initAmplitude = () => {
  try {
    if (!config.amplitude.apiKey) {
      throw new Error("Amplitude API key is not defined");
    }

    amplitude.init(config.amplitude.apiKey);

    console.log("Amplitude initialized successfully");
    return amplitude;
  } catch (error) {
    console.error("Failed to initialize Amplitude:", error);
    throw error;
  }
};

export const amplitudeClient = initAmplitude();
