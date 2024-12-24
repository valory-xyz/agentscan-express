import { Router } from "express";
import { olasPool } from "../../initalizers/postgres";

const router = Router();

router.get("/", async (req: any, res) => {
  try {
    const limit = 20;
    const chain = req.query.chain?.toLowerCase();
    const cursor = req.query.cursor ? parseFloat(req.query.cursor) : null;
    const excludedIds = req.query.excludedIds
      ? req.query?.excludedIds?.split(",")
      : [];

    if (chain && !["base", "gnosis", "mainnet"].includes(chain)) {
      return res.status(400).json({ message: "Invalid chain parameter" });
    }

    const queryParams: any[] = [limit];
    let paramCounter = 2;

    let query = `
      WITH RankedAgents AS (
        SELECT 
          ai.id AS id,
          ai.agent_id,
          a.image,
          a.name,
          a.description,
          a.code_uri,
          aft.timestamp,
          tx.value AS highest_value,
          ROW_NUMBER() OVER (PARTITION BY ai.agent_id ORDER BY tx.value DESC) as rn
        FROM "4ecc96db-a6ba-45ec-a91b-e5c4d49fa206".agent_from_transaction AS aft
        JOIN "4ecc96db-a6ba-45ec-a91b-e5c4d49fa206".agent_instance AS ai ON aft.agent_instance_id = ai.id
        JOIN "4ecc96db-a6ba-45ec-a91b-e5c4d49fa206".agent AS a ON ai.agent_id = a.id
        JOIN "4ecc96db-a6ba-45ec-a91b-e5c4d49fa206".transaction AS tx ON tx.hash = aft.transaction_hash
        WHERE 1=1
        ${chain ? `AND aft.chain = $${paramCounter++}` : ""}
        ${
          excludedIds.length > 0
            ? `AND ai.id NOT IN (${excludedIds
                .map((_: any, i: number) => `$${paramCounter + i}`)
                .join(",")})`
            : ""
        }
      )
      SELECT 
        id,
        agent_id,
        image,
        name,
        description,
        code_uri,
        timestamp,
        highest_value
      FROM RankedAgents
      WHERE rn = 1
        ${cursor ? `AND highest_value < $${paramCounter++}` : ""}
      ORDER BY highest_value DESC
      LIMIT $1
    `;

    if (chain) {
      queryParams.push(chain);
    }
    if (cursor) {
      queryParams.push(cursor);
    }
    if (excludedIds.length > 0) {
      queryParams.push(...excludedIds);
    }

    const result = await olasPool.query(query, queryParams);

    const transactions = result.rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      agent: {
        image: row.image || null,
        name: row.name || null,
        description: row.description || null,
        codeUri: row.code_uri || null,
      },
      highestValue: row.highest_value || null,
    }));

    const nextCursor =
      transactions.length === limit
        ? transactions[transactions.length - 1].highestValue
        : null;

    if (!transactions || transactions.length === 0) {
      return res.status(200).json({
        transactions: [],
        nextCursor: null,
      });
    }

    return res.status(200).json({
      transactions,
      nextCursor,
    });
  } catch (error: any) {
    console.error("Error processing transactions:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
