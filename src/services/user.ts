import { db } from "../initalizers/postgres";
import { redis } from "../initalizers/redis";
import { User } from "../types";
import { users } from "../db/migrations/schema";
import { eq, inArray } from "drizzle-orm";

export const user_cache_key = (userId: string) => `user:${userId}`;

// Helper function to convert database user to User type
function convertToUser(dbUser: any): User {
  return {
    id: dbUser.id,
    username: dbUser.username,
    pfp: dbUser.pfp || undefined,
    bio: dbUser.bio || undefined,
    created_at: new Date(dbUser.created_at || Date.now()),
    updated_at: new Date(dbUser.updated_at || Date.now()),
  };
}

/**
 * Fetches user data from Redis cache or PostgreSQL database if not cached.
 * @param userId - The ID of the user to fetch.
 * @returns {Promise<User>} - Returns a promise that resolves to the user object.
 */
export async function getUserById(userId: string): Promise<User> {
  const redisKey = user_cache_key(userId);

  // Try to get the user data from Redis
  const cachedUser = await redis.get(redisKey);
  if (cachedUser) {
    return convertToUser(JSON.parse(cachedUser));
  }

  // If not in Redis, fetch from PostgreSQL using Drizzle
  const result = await db.select().from(users).where(eq(users.id, userId));

  if (result.length === 0) {
    throw new Error(`User with ID ${userId} not found`);
  }

  const user = convertToUser(result[0]);

  // Cache the user data in Redis
  await redis.set(redisKey, JSON.stringify(result[0]), {
    EX: 3600, // Cache for 1 hour
  });

  return user;
}

/**
 * Fetches user data for multiple user IDs from Redis cache or PostgreSQL database if not cached.
 * @param userIds - An array of user IDs to fetch.
 * @returns {Promise<Map<string, User>>} - Returns a promise that resolves to a Map of user objects keyed by user ID.
 */
export async function getUsersByIds(
  userIds: string[]
): Promise<Map<string, User>> {
  const userMap = new Map<string, User>();
  const redisKeys = userIds.map((id) => user_cache_key(id.toString()));

  if (userIds.length === 0) {
    return userMap;
  }

  // Fetch all users from Redis in a single MGET operation
  const cachedUsers = await redis.mGet(redisKeys);

  // Process cached results and identify missing users
  const missingUserIds: string[] = [];
  if (!cachedUsers) {
    missingUserIds.push(...userIds);
  } else {
    userIds.forEach((id, index) => {
      if (cachedUsers && cachedUsers[index]) {
        userMap.set(
          id,
          convertToUser(JSON.parse(cachedUsers[index] as string))
        );
      } else {
        missingUserIds.push(id);
      }
    });
  }

  // If there are missing users, fetch them from PostgreSQL using Drizzle
  if (missingUserIds.length > 0) {
    const result = await db
      .select()
      .from(users)
      .where(inArray(users.id, missingUserIds));

    result.forEach((dbUser) => {
      const user = convertToUser(dbUser);
      userMap.set(user.id, user);
      redis.set(user_cache_key(user.id.toString()), JSON.stringify(dbUser), {
        EX: 60 * 60, // Cache for 1 hour
      });
    });
  }

  return userMap;
}
