import { Router } from "express";
import {
  getTeamData,
  generateConversationResponse,
  PromptType,
} from "../../services/conversation";

const router = Router();

router.post("/", async (req: any, res) => {
  let {
    question,
    messages,
    teamId,
    type = "general",
    instance = null,
  } = req.body;

  if (instance) {
    instance = instance.toLowerCase();
  }

  if (!["general", "agent"].includes(type)) {
    return res.status(400).json({
      message: "Invalid type. Must be either 'general' or 'agent'.",
    });
  }

  if (!question) {
    return res.status(400).json({ message: "question is required." });
  }

  try {
    const teamData = await getTeamData(teamId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    for await (const response of generateConversationResponse(
      question,
      messages,
      teamData,
      type as PromptType,
      instance
    )) {
      res.write(`${JSON.stringify(response)}\n\n`);

      if (response.error) {
        break;
      }
    }

    res.end();
  } catch (error: any) {
    if (error.message === "Team not found") {
      return res.status(404).json({ message: "Team not found" });
    }
    console.error("Error processing request:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
