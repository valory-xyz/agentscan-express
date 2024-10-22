import { pool } from "../initalizers/postgres";

export const Permissions = {
  ADMINISTRATOR: BigInt(1) << BigInt(0),
  MANAGE_SERVER: BigInt(1) << BigInt(1),
  MANAGE_ROLES: BigInt(1) << BigInt(2),
  MANAGE_CHANNELS: BigInt(1) << BigInt(3),
  KICK_MEMBERS: BigInt(1) << BigInt(4),
  BAN_MEMBERS: BigInt(1) << BigInt(5),
  CREATE_INVITE: BigInt(1) << BigInt(6),
  CHANGE_NICKNAME: BigInt(1) << BigInt(7),
  MANAGE_NICKNAMES: BigInt(1) << BigInt(8),
  MANAGE_EMOJIS: BigInt(1) << BigInt(9),
  READ_MESSAGES: BigInt(1) << BigInt(10),
  SEND_MESSAGES: BigInt(1) << BigInt(11),
  DELETE_SERVER: BigInt(1) << BigInt(12),
} as const;

export type PermissionKey = keyof typeof Permissions;

export async function checkPermission(
  userId: string,
  serverId: string,
  requiredPermission: PermissionKey
): Promise<boolean> {
  try {
    // Check if the user is the owner of the server
    const ownerResult = await pool.query(
      `SELECT owner_id FROM servers WHERE id = $1`,
      [serverId]
    );

    if (ownerResult.rows[0]?.owner_id === userId) {
      return true; // Server owner has all permissions
    }

    // If not the owner, check roles and permissions
    const result = await pool.query(
      `SELECT *
       FROM server_members sm
       JOIN roles r ON r.server_id = sm.server_id
       WHERE sm.user_id = $1 AND sm.server_id = $2`,
      [userId, serverId]
    );

    let combinedPermissions = BigInt(0);
    for (const row of result.rows) {
      combinedPermissions |= BigInt(row.permissions);
    }

    return (
      (combinedPermissions & Permissions.ADMINISTRATOR) ===
        Permissions.ADMINISTRATOR ||
      (combinedPermissions & Permissions[requiredPermission]) ===
        Permissions[requiredPermission]
    );
  } catch (error) {
    console.error("Error checking permissions:", error);
    return false;
  }
}
