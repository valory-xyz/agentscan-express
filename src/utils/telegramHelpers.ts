import { Context } from "telegraf";

export async function isGroupAdmin(ctx: Context): Promise<boolean> {
  try {
    if (!ctx.chat?.id || !ctx.from?.id) return false;

    const chatMember = await ctx.telegram.getChatMember(
      ctx.chat.id,
      ctx.from.id
    );
    return ["creator", "administrator"].includes(chatMember.status);
  } catch (error) {
    console.error("Error checking admin status:", error);
    return false;
  }
}
