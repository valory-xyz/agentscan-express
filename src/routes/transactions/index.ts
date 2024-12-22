import axios from "axios";
import { Router } from "express";
import { getTransactions } from "../../services/transactions";

const router = Router();

const getTransactionLink = (chain: string, txHash: string) => {
  switch (chain.toLowerCase()) {
    case "gnosis":
      return `https://gnosisscan.io/tx/${txHash}`;
    case "base":
      return `https://basescan.org/tx/${txHash}`;
    case "mainnet":
      return `https://etherscan.io/tx/${txHash}`;
    default:
      return "";
  }
};

router.get("/", async (req: any, res) => {
  try {
    const limit = 20;
    const cursor = req.query.cursor || null;
    const chain = req.query.chain?.toLowerCase();
    const instance = req.query.instance;

    if (chain && !["base", "gnosis", "mainnet"].includes(chain)) {
      return res.status(400).json({ message: "Invalid chain parameter" });
    }

    const transactionsData = await getTransactions(
      instance,
      chain,
      cursor,
      limit
    );

    const transactions = transactionsData.transactions;
    const nextCursor = transactionsData.nextCursor;

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
