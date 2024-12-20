import axios from "axios";
import { Router } from "express";

const router = Router();

router.get("/", async (req: any, res) => {
  try {
    const graphQLURL =
      "https://agentscan-agentindexing-kx37-uncomment-void.ponder-dev.com";
    const instanceId = req.query.id;

    if (!instanceId) {
      return res.status(400).json({ message: "Instance ID is required" });
    }

    const response = await axios.post(graphQLURL, {
      query: `query getInstance {
        agentInstance(id: "${instanceId}") {
          id
          timestamp
          agent {
            image
            name
            description
            codeUri
            timestamp
          }
        }
      }`,
    });

    const instance = response?.data?.data?.agentInstance;

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
    const graphQLURL =
      "https://agentscan-agentindexing-kx37-uncomment-void.ponder-dev.com";
    const instanceId = req.query.id;

    if (!instanceId) {
      return res.status(400).json({ message: "Instance ID is required" });
    }

    const response = await axios.post(graphQLURL, {
      query: `query getInstance {
          agentInstance(id: "${instanceId}") {
            id
            timestamp
            agent {
              image
              name
              description
              codeUri
              timestamp
            }
          }
        }`,
    });

    const instance = response?.data?.data?.agentInstance;

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
