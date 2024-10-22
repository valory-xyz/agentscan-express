import { redis } from "../initalizers/redis";

export async function getUsersOnlineStatus(
  userIds: string[]
): Promise<Record<string, boolean>> {
  const keys = userIds.map((userId) => `user_online:${userId}`);
  if (keys.length === 0) {
    return {};
  }
  const results = await redis.mGet(keys);

  return userIds.reduce((acc, userId, index) => {
    acc[userId] = results[index] === "true";
    return acc;
  }, {} as Record<string, boolean>);
}

export async function setUserOnline(
  userId: string,
  ttl: number
): Promise<void> {
  await redis.set(`user_online:${userId}`, "true", { EX: ttl });
}

export async function removeUserOnline(userId: string): Promise<void> {
  await redis.del(`user_online:${userId}`);
}
