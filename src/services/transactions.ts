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
    originalName: string;
  };
}

export async function getInstanceData(instanceId: string): Promise<Instance> {
  const cacheKey = `instance:${instanceId}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log("Returning cached data in getInstanceData");
      return JSON.parse(cached);
    }

    const newSchemaQuery = `
      SELECT 
        ai.id,
        ai.timestamp,
        a.id as agent_id,
        a.image,
        a.name,
        a.description,
        a.code_uri,
        a.timestamp as agent_timestamp
      FROM "log-df28".agent_instance ai
      JOIN "log-df28".agent a ON ai.agent_id = a.id
      WHERE ai.id = $1
    `;

    let result;
    try {
      result = await olasPool.query(newSchemaQuery, [instanceId]);
    } catch (error) {
      console.log("Failed to query log-df28 schema, falling back:", error);
      const fallbackQuery = newSchemaQuery.replace(
        /\"log-df28\"/g,
        '"4ecc96db-a6ba-45ec-a91b-e5c4d49fa206"'
      );
      result = await olasPool.query(fallbackQuery, [instanceId]);
    }

    if (!result.rows[0]) {
      throw new Error("Instance not found");
    }

    const instance = {
      id: result.rows[0].id,
      timestamp: result.rows[0].timestamp,
      agent: {
        id: result.rows[0].agent_id,
        image: result.rows[0].image,
        name: formatAgentName(result.rows[0].name || "", result.rows[0].id),
        description: result.rows[0].description,
        codeUri: result.rows[0].code_uri,
        timestamp: result.rows[0].agent_timestamp,
        originalName: result.rows[0].name,
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

function encodeCursor(cursor: string | number): string {
  return Buffer.from(String(cursor)).toString("base64");
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64").toString("utf-8");
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
  const decodedCursor = cursor ? decodeCursor(cursor) : null;
  const cacheKey = `transactions:${instance}:${normalizedChain}:${decodedCursor}:${limit}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log("Returning cached data in getTransactions");
      return JSON.parse(cached);
    }

    const queryParams: any[] = [instance, limit];
    let paramCounter = 3;

    let query = `
      WITH filtered_transactions AS (
        SELECT DISTINCT ON (aft.transaction_hash)
          aft.timestamp,
          aft.transaction_hash,
          aft.chain,
          tx.from as from_addr,
          tx.to as to_addr,
          tx.value
        FROM "log-df28".agent_from_transaction aft
        JOIN "log-df28".transaction tx ON tx.hash = aft.transaction_hash
        WHERE aft.agent_instance_id = $1
    `;

    if (normalizedChain) {
      query += ` AND aft.chain = $${paramCounter}`;
      queryParams.push(normalizedChain);
      paramCounter++;
    }

    if (decodedCursor) {
      query += ` AND aft.timestamp < $${paramCounter}`;
      queryParams.push(decodedCursor);
      paramCounter++;
    }

    query += `
        ORDER BY aft.transaction_hash, aft.timestamp DESC
        LIMIT $2
      )
      SELECT 
        ft.*,
        COALESCE(
          json_agg(
            json_build_object(
              'decoded_data', l.decoded_data,
              'event_name', l.event_name,
              'address', l.address
            )
          ) FILTER (WHERE l.transaction_hash IS NOT NULL),
          '[]'
        ) as logs
      FROM filtered_transactions ft
      LEFT JOIN "log-df28".log l ON l.transaction_hash = ft.transaction_hash
      GROUP BY ft.timestamp, ft.transaction_hash, ft.chain, ft.from_addr, ft.to_addr, ft.value
      ORDER BY ft.timestamp DESC
    `;

    let result;
    try {
      result = await olasPool.query(query, queryParams);
    } catch (error) {
      console.log("Failed to query log-df28 schema, falling back:", error);
      query = query.replace(
        /\"log-df28\"/g,
        '"4ecc96db-a6ba-45ec-a91b-e5c4d49fa206"'
      );
      result = await olasPool.query(query, queryParams);
    }

    const transactions = result.rows.map((row) =>
      formatTransaction({
        timestamp: row.timestamp,
        transaction_hash: row.transaction_hash,
        chain: row.chain,
        from_addr: row.from_addr,
        to_addr: row.to_addr,
        value: row.value,
        logs: row.logs === "[null]" ? [] : row.logs,
      })
    );

    const nextCursor =
      transactions.length === limit
        ? encodeCursor(transactions[transactions.length - 1].timestamp)
        : null;

    const resultObj = { transactions, nextCursor };
    redis.set(cacheKey, JSON.stringify(resultObj), { EX: TX_TTL });
    return resultObj;
  } catch (error) {
    console.error("Error fetching transactions:", error);
    if (axios.isAxiosError(error)) {
      console.error("Axios error details:", {
        status: error.response?.status,
        data: error.response?.data,
      });
    }
    redis.set(cacheKey, JSON.stringify({ error: true }), {
      EX: ERROR_TTL,
    });
    throw error;
  }
}

export function formatTransaction(item: any): Transaction {
  const normalizedChain = item?.chain || item?.transaction?.chain || "mainnet";
  const logs = item.transaction?.logs?.items || item.transaction?.logs || [];

  return {
    timestamp: item.timestamp,
    transactionHash: item.transactionHash || item.transaction_hash,
    chain: normalizedChain,
    transaction: {
      from: item.transaction?.from || item.from_addr,
      to: item.transaction?.to || item.to_addr,
      value: item.transaction?.value || item.value,
      logs: logs.map((log: any) => ({
        decodedData: log.decodedData || log.decoded_data,
        eventName: log.eventName || log.event_name,
        address: log.address,
      })),
    },
    transactionLink: getTransactionLink(
      normalizedChain,
      item.transactionHash || item.transaction_hash
    ),
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

export function formatAgentName(agentName: string, instanceId: string): string {
  const simpleName =
    agentName
      .split("/")
      .pop()
      ?.split(":")[0]
      ?.replace(/^\w/, (c) => c.toUpperCase())
      ?.replace(/_/g, " ") || agentName;
  const explorerLink = getExplorerLink(instanceId);

  return `${simpleName} (${explorerLink})`;
}

function getExplorerLink(address: string): string {
  const shortAddress = `${address.substring(0, 6)}...${address.substring(
    address.length - 4
  )}`;
  return `[${shortAddress}](https://blockscan.com/address/${address})`;
}
