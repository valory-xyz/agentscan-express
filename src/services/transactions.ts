import axios from "axios";
import { redis } from "../initalizers/redis";
import { graphQLURL } from "./constants";
import { olasPool } from "../initalizers/postgres";

const CACHE_TTL = 15 * 60;
const TX_TTL = 4 * 60;
const ERROR_TTL = 15;

interface Transaction {
  timestamp: string;
  transactionHash: string;
  chain: string;
  transaction: {
    from: string;
    to: string;
    value: string;
    logs: {
      decodedData: any;
      eventName: string;
      address: string;
    }[];
  };
  transactionLink: string;
}

interface Instance {
  id: string;
  timestamp: string;
  agent: {
    id: string;
    image: string;
    name: string;
    description: string;
    codeUri: string;
    timestamp: string;
  };
}

export async function getInstanceData(instanceId: string): Promise<Instance> {
  const cacheKey = `instance:${instanceId}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const query = `
      SELECT 
        ai.id,
        ai.timestamp,
        a.id as agent_id,
        a.image,
        a.name,
        a.description,
        a.code_uri,
        a.timestamp as agent_timestamp
      FROM "4ecc96db-a6ba-45ec-a91b-e5c4d49fa206".agent_instance ai
      JOIN "4ecc96db-a6ba-45ec-a91b-e5c4d49fa206".agent a ON ai.agent_id = a.id
      WHERE ai.id = $1
    `;

    const result = await olasPool.query(query, [instanceId]);

    if (!result.rows[0]) {
      throw new Error("Instance not found");
    }

    const instance = {
      id: result.rows[0].id,
      timestamp: result.rows[0].timestamp,
      agent: {
        id: result.rows[0].agent_id,
        image: result.rows[0].image,
        name: result.rows[0].name,
        description: result.rows[0].description,
        codeUri: result.rows[0].code_uri,
        timestamp: result.rows[0].agent_timestamp,
      },
    };

    redis.set(cacheKey, JSON.stringify(instance), { EX: CACHE_TTL });
    return instance;
  } catch (error) {
    console.error("Error fetching instance:", error);
    await redis.set(cacheKey, JSON.stringify({ error: true }), {
      EX: ERROR_TTL,
    });
    throw error;
  }
}

export async function getTransactions(
  instance: string,
  chain?: string | null,
  cursor?: string | null,
  limit: number = 20
): Promise<{ transactions: Transaction[]; nextCursor: string | null }> {
  if (!instance) {
    throw new Error("Instance ID is required");
  }

  const normalizedChain = chain?.startsWith("0x") ? "mainnet" : chain || null;
  const cacheKey = `transactions:${instance}:${normalizedChain}:${cursor}:${limit}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log("Returning cached data:");
      return JSON.parse(cached);
    }

    const queryParams: any[] = [instance, limit];
    let paramCounter = 3;

    let query = `
      SELECT 
        aft.timestamp,
        aft.transaction_hash,
        aft.chain,
        tx.from as from_addr,
        tx.to as to_addr,
        tx.value,
        l.decoded_data,
        l.event_name,
        l.address
      FROM "4ecc96db-a6ba-45ec-a91b-e5c4d49fa206".agent_from_transaction aft
      JOIN "4ecc96db-a6ba-45ec-a91b-e5c4d49fa206".transaction tx ON tx.hash = aft.transaction_hash
      LEFT JOIN "4ecc96db-a6ba-45ec-a91b-e5c4d49fa206".log l ON l.transaction_hash = aft.transaction_hash
      WHERE aft.agent_instance_id = $1
    `;

    if (normalizedChain) {
      query += ` AND aft.chain = $${paramCounter}`;
      queryParams.push(normalizedChain);
      paramCounter++;
    }

    if (cursor) {
      query += ` AND aft.timestamp < $${paramCounter}`;
      queryParams.push(cursor);
      paramCounter++;
    }

    query += ` ORDER BY aft.timestamp DESC LIMIT $2`;

    const dbResult = await olasPool.query(query, queryParams);

    const txMap = new Map();
    dbResult.rows.forEach((row) => {
      if (!txMap.has(row.transaction_hash)) {
        txMap.set(row.transaction_hash, {
          timestamp: row.timestamp,
          transactionHash: row.transaction_hash,
          chain: row.chain || "mainnet",
          transaction: {
            from: row.from_addr,
            to: row.to_addr,
            value: row.value,
            logs: [],
          },
        });
      }

      if (row.event_name) {
        txMap.get(row.transaction_hash).transaction.logs.push({
          decodedData: row.decoded_data,
          eventName: row.event_name,
          address: row.address,
        });
      }
    });

    const transactions = Array.from(txMap.values()).map((tx) => ({
      ...tx,
      transactionLink: getTransactionLink(tx.chain, tx.transactionHash),
    }));

    const nextCursor =
      transactions.length === limit
        ? transactions[transactions.length - 1].timestamp
        : null;

    const result = { transactions, nextCursor };
    await redis.set(cacheKey, JSON.stringify(result), { EX: TX_TTL });
    return result;
  } catch (error) {
    console.error("Error fetching transactions:", error);
    if (axios.isAxiosError(error)) {
      console.error("Axios error details:", {
        status: error.response?.status,
        data: error.response?.data,
      });
    }
    await redis.set(cacheKey, JSON.stringify({ error: true }), {
      EX: ERROR_TTL,
    });
    throw error;
  }
}

function formatTransaction(item: any): Transaction {
  const normalizedChain = item?.transaction?.chain || "mainnet";

  return {
    timestamp: item.timestamp,
    transactionHash: item.transactionHash,
    chain: normalizedChain,
    transaction: {
      from: item.transaction.from,
      to: item.transaction.to,
      value: item.transaction.value,

      logs: item.transaction.logs.items,
    },
    transactionLink: getTransactionLink(normalizedChain, item.transactionHash),
  };
}

function getTransactionLink(chain: string | undefined, txHash: string): string {
  const chainName = (chain || "mainnet").toLowerCase();

  switch (chainName) {
    case "gnosis":
      return `https://gnosisscan.io/tx/${txHash}`;
    case "base":
      return `https://basescan.org/tx/${txHash}`;
    case "mainnet":
    default:
      return `https://etherscan.io/tx/${txHash}`;
  }
}
