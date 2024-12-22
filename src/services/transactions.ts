import axios from "axios";
import { redis } from "../initalizers/redis";

const CACHE_TTL = 15 * 60;
const TX_TTL = 4 * 60;
const ERROR_TTL = 15;
const graphQLURL = "https://agentscan-agentindexing-kx37.ponder-dev.com";

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

    const response = await axios.post(graphQLURL, {
      query: `query getInstance {
        agentInstance(id: "${instanceId}") {
          id
          timestamp
          agent {
            id
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
      throw new Error("Instance not found");
    }

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
  chain?: string,
  cursor?: string | null,
  limit: number = 20
): Promise<{ transactions: Transaction[]; nextCursor: string | null }> {
  if (!instance) {
    throw new Error("Instance ID is required");
  }

  const normalizedChain = chain?.startsWith("0x") ? "mainnet" : chain;

  const cacheKey = `transactions:${instance}:${normalizedChain}:${cursor}:${limit}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log("Returning cached data:");
      return JSON.parse(cached);
    }

    const response = await axios.post(graphQLURL, {
      query: `query getTransactions {
        agentFromTransactions(
          limit: ${limit}${cursor ? `, after: "${cursor}"` : ""}
          where: { agentInstanceId: "${instance}" }
          ${normalizedChain ? `, chain: "${normalizedChain}"` : ""}
          orderBy: "timestamp"
          orderDirection: "desc"
        ) {
          pageInfo {
            endCursor
          }
          items {
            timestamp
            transactionHash
            transaction {
              from
              to
              chain
              value
              decodedFunction
              logs {
                items {
                  decodedData
                  eventName
                  address
                }
              }
            }
          }
        }
      }`,
    });

    const result = {
      transactions:
        response?.data?.data?.agentFromTransactions?.items?.map(
          formatTransaction
        ) || [],
      nextCursor:
        response?.data?.data?.agentFromTransactions?.pageInfo?.endCursor ||
        null,
    };

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
