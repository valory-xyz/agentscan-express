import { Router } from "express";
import { getAgents } from "../../services/agentService";

const router = Router();

router.get("/", async (req: any, res) => {
  try {
    const chain = req.query.chain?.toLowerCase();
    const cursor = req.query.cursor ? parseFloat(req.query.cursor) : null;
    const excludedIds = req.query.excludedIds
      ? req.query?.excludedIds?.split(",")
      : [];

    if (chain && !["base", "gnosis", "mainnet"].includes(chain)) {
      return res.status(400).json({ message: "Invalid chain parameter" });
    }

    const result = await getAgents({ chain, cursor, excludedIds });
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("Error processing transactions:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
