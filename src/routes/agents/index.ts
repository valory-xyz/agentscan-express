import axios from "axios";
import { Router } from "express";

const router = Router();

router.get("/", async (req: any, res) => {
  try {
    const graphQLURL =
      "https://agentscan-agentindexing-kx37-uncomment-void.ponder-dev.com";
    const limit = 20;
    const cursor = req.query.cursor || null;
    const chain = req.query.chain?.toLowerCase();

    if (chain && !["base", "gnosis", "mainnet"].includes(chain)) {
      return res.status(400).json({ message: "Invalid chain parameter" });
    }

    const response = await axios.post(graphQLURL, {
      query: `query getTransactions {
        agentInstances(
          limit: ${limit}${cursor ? `, after: "${cursor}"` : ""}
          ${chain ? `, where: { chain: "${chain}" }` : ""}
          orderBy: "timestamp"
          orderDirection: "desc"
        ) {
          pageInfo {
            endCursor
          }
          items {
            timestamp
            id
            agent {
              image
              name
              description
              codeUri
              timestamp
            }
       
          }
        }
      }`,
    });

    const transactions = response?.data?.data?.agentInstances?.items.map(
      (item: any) => ({
        id: item.id,
        timestamp: item.timestamp,
        agent: item.agent,
      })
    );

    const nextCursor =
      response?.data?.data?.agentInstances?.pageInfo?.endCursor || null;
    if (!transactions || transactions.length === 0) {
      return res.status(200).json({
        transactions: [],
        nextCursor: null,
      });
    }

    return res.status(200).json({ transactions, nextCursor });
  } catch (error: any) {
    if (error.message === "No transactions found") {
      return res.status(404).json({ message: "No transactions found" });
    }
    console.error("Error processing transactions:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
