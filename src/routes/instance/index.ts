import axios from "axios";
import { Router } from "express";
import { getInstanceData } from "../../services/transactions";

const router = Router();

router.get("/", async (req: any, res) => {
  try {
    const instanceId = req.query.id?.toLowerCase();

    if (!instanceId) {
      return res.status(400).json({ message: "Instance ID is required" });
    }

    const instance = await getInstanceData(instanceId);

    if (!instance) {
      return res.status(404).json({ message: "Instance not found" });
    }

    return res.status(200).json({ instance });
  } catch (error: any) {
    console.error("Error fetching instance:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/", async (req: any, res) => {
  try {
    const instanceId = req.query.id;

    if (!instanceId) {
      return res.status(400).json({ message: "Instance ID is required" });
    }

    const instance = await getInstanceData(instanceId);

    if (!instance) {
      return res.status(404).json({ message: "Instance not found" });
    }

    return res.status(200).json({ instance });
  } catch (error: any) {
    console.error("Error fetching instance:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
