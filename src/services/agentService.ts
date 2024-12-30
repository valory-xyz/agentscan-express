import { olasPool } from "../initalizers/postgres";
import { redis } from "../initalizers/redis";
import { formatAgentName } from "./transactions";

const CACHE_DURATION = 60 * 10; // 10 minutes

interface AgentTransaction {
  id: string;
  timestamp: string;
  agent: {
    image: string | null;
    name: string | null;
    description: string | null;
    codeUri: string | null;
  };
  highestValue: number | null;
}

interface GetAgentsParams {
  chain?: string;
  cursor?: number | null;
  excludedIds?: string[];
  limit?: number;
}

interface GetAgentsResult {
  transactions: AgentTransaction[];
  nextCursor: number | null;
}

export async function getAgents({
  chain,
  cursor = null,
  excludedIds = [],
  limit = 20,
}: GetAgentsParams): Promise<GetAgentsResult> {
  const cacheKey = `agents:${JSON.stringify({
    chain,
    cursor,
    excludedIds,
    limit,
  })}`;

  try {
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      console.log("Returning cached data in getAgents");
      return JSON.parse(cachedData);
    }
  } catch (error) {
    console.error("Redis cache error:", error);
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
      FROM "log-df28".agent_from_transaction AS aft
      JOIN "log-df28".agent_instance AS ai ON aft.agent_instance_id = ai.id
      JOIN "log-df28".agent AS a ON ai.agent_id = a.id
      JOIN "log-df28".transaction AS tx ON tx.hash = aft.transaction_hash
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

  let result;
  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      result = await olasPool.query(query, queryParams);
      break;
    } catch (error: any) {
      console.error(`Query attempt ${retryCount + 1} failed:`, error.message);

      if (error.message.includes("shared memory segment")) {
        if (retryCount === maxRetries - 1) {
          throw new Error(
            "Database is currently under heavy load. Please try again later."
          );
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (retryCount + 1))
        );
        retryCount++;
        continue;
      }

      try {
        const fallbackQuery = query.replace(
          /\"log-df28\"/g,
          '"4ecc96db-a6ba-45ec-a91b-e5c4d49fa206"'
        );
        result = await olasPool.query(fallbackQuery, queryParams);
        break;
      } catch (fallbackError) {
        console.error("Fallback query failed:", fallbackError);
        throw fallbackError;
      }
    }
  }

  if (!result) {
    return {
      transactions: [],
      nextCursor: null,
    };
  }

  const transactions = result?.rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    agent: {
      image: row.image || null,
      name: formatAgentName(row.name || "", row.id),
      description: row.description || null,
      codeUri: row.code_uri || null,
    },
    highestValue: row.highest_value || null,
  }));

  const nextCursor =
    transactions.length === limit
      ? transactions[transactions.length - 1].highestValue
      : null;

  const resultObj = {
    transactions: transactions || [],
    nextCursor,
  };

  try {
    redis.set(cacheKey, JSON.stringify(resultObj), {
      EX: CACHE_DURATION,
    });
  } catch (error) {
    console.error("Redis cache set error:", error);
  }

  return resultObj;
}
