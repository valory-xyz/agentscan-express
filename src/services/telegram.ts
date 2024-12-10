import { Context } from "telegraf";

import { generateConversationResponse, getTeamData } from "./conversation";
import { checkRateLimit } from "../utils/messageLimiter";
import { amplitudeClient } from "../initalizers/amplitude";
import { isGroupAdmin } from "../utils/telegramHelpers";
import { pool } from "../initalizers/postgres";

const TEAM_ID = "56917ba2-9084-40c3-b9cf-67cd30cc389a";
const threadContexts = new Map<number, any[]>();
const TYPING_INTERVAL_MS = 4000;

async function isSupergroupAllowed(
  chatId: number,
  threadId?: number
): Promise<boolean> {
  console.log("Checking supergroup access for:", { chatId, threadId });

  const result = await pool.query(
    `SELECT enabled FROM telegram_allowed_supergroups 
     WHERE chat_id = $1 
     AND (thread_id = $2 OR (thread_id IS NULL AND $2 IS NULL))`,
    [chatId, threadId]
  );

  return result.rows.length > 0 && result.rows[0].enabled === true;
}

function formatThreadContextForAI(threadContext: any[]): any[] {
  return threadContext.map((msg) => ({
    role: msg.from?.is_bot ? "assistant" : "user",
    content: msg.text?.replace(/@\w+/g, "").trim() || "",
  }));
}

async function startTypingIndicator(
  ctx: Context,
  chatId: number
): Promise<NodeJS.Timeout> {
  const threadId = ctx.msg?.isAccessible()
    ? ctx.msg.is_topic_message
      ? ctx.msg.message_thread_id
      : undefined
    : undefined;

  await ctx.telegram.sendChatAction(chatId, "typing", {
    message_thread_id: threadId,
  });
  return setInterval(async () => {
    try {
      await ctx.telegram.sendChatAction(chatId, "typing", {
        message_thread_id: threadId,
      });
    } catch (error) {
      console.error("Error sending typing indicator:", error);
    }
  }, TYPING_INTERVAL_MS);
}

export const handleTelegramMessage = async (ctx: Context): Promise<void> => {
  const messageId = ctx.message?.message_id;
  try {
    if (!ctx.botInfo) {
      console.error("Bot not properly initialized");
      return;
    }

    if (!ctx.message || !("text" in ctx.message)) {
      console.log("No message or text content");
      return;
    }

    if (ctx.message?.text?.startsWith("/")) {
      console.log("Command message - ignoring");
      return;
    }

    const isPrivateChat = ctx.chat?.type === "private";
    const isBotMention = ctx.message.text.includes(`@${ctx.botInfo.username}`);

    if (ctx.chat?.type === "supergroup") {
      const threadId = ctx.msg?.isAccessible()
        ? ctx.msg.is_topic_message
          ? ctx.msg.message_thread_id
          : undefined
        : undefined;

      const isAllowed = await isSupergroupAllowed(ctx.chat.id, threadId);
      console.log("Supergroup access:", { isAllowed, threadId });
      if (!isAllowed) {
        console.log("Supergroup not allowed");
        return;
      }
    }

    if (!isPrivateChat && !isBotMention) return;

    const userId = ctx.from?.id.toString();
    if (!userId) return;

    const { limited, ttl } = await checkRateLimit(userId, true);

    if (limited) {
      await ctx.reply(
        `You've reached the message limit. Please try again in ${Math.ceil(
          ttl || 0
        )} seconds.`,
        {
          reply_parameters: {
            message_id: messageId,
          },
        } as any
      );
      return;
    }

    const currentMessageId = ctx.message.message_id;

    let threadContext: any[] = [];

    if (currentMessageId) {
      threadContext = threadContexts.get(currentMessageId) || [];
    }

    threadContext.push(ctx.message);

    threadContexts.set(currentMessageId, threadContext);

    const formattedContext = formatThreadContextForAI(threadContext);

    if (ctx.chat?.id) {
      await ctx.telegram.sendChatAction(ctx.chat.id, "typing");
    }

    const teamData = await getTeamData(TEAM_ID);

    amplitudeClient.track({
      event_type: "conversation_made",
      user_id: userId,
      user_properties: {
        username: ctx.from?.username || "unknown",
      },
      event_properties: {
        teamId: TEAM_ID,
        question: ctx.message.text
          .replace(`@${ctx.botInfo.username}`, "")
          .trim(),
        source: "telegram",
        messages: formattedContext,
        chat_id: ctx.chat?.id || "unknown",
        chat_type: ctx.chat?.type || "unknown",
      },
    });

    await streamResponse(
      ctx,
      ctx.message.text.replace(`@${ctx.botInfo.username}`, "").trim(),
      formattedContext,
      teamData,
      threadContext
    );
  } catch (error) {
    console.error("Error handling message:", error);
    try {
      await ctx.reply(
        "Sorry, something went wrong while processing your message.",
        {
          reply_parameters: {
            message_id: messageId,
          },
          parse_mode: "Markdown",
        } as any
      );
    } catch (replyError) {
      console.error("Failed to send error message:", replyError);
    }
  }
};

async function streamResponse(
  ctx: Context,
  question: string,
  conversationHistory: any[],
  teamData: any,
  threadContext: any[]
): Promise<void> {
  let fullResponse = "";
  let typingInterval: NodeJS.Timeout | undefined;

  try {
    if (ctx.chat?.id) {
      typingInterval = await startTypingIndicator(ctx, ctx.chat?.id);
    }

    const threadId = ctx.msg?.isAccessible()
      ? ctx.msg.is_topic_message
        ? ctx.msg.message_thread_id
        : undefined
      : undefined;

    for await (const response of generateConversationResponse(
      question,
      conversationHistory,
      teamData,
      false
    )) {
      if (response.error) {
        if (typingInterval) {
          clearInterval(typingInterval);
        }
        await ctx.reply(
          "Sorry, I encountered an error while processing your request.",
          {
            reply_parameters: {
              message_id: ctx.message?.message_id ?? 0,
            },
          } as any
        );
        return;
      }

      if (response.done) {
        if (typingInterval) {
          clearInterval(typingInterval);
        }

        const sentMessage = await ctx.reply(fullResponse, {
          reply_parameters: {
            message_id: ctx.message?.message_id ?? 0,
          },
          message_thread_id: threadId,
          parse_mode: "Markdown",
        } as any);

        if (sentMessage) {
          const updatedContext = [
            ...threadContext,
            {
              text: fullResponse,
              from: { ...ctx.botInfo, is_bot: true },
            },
          ];

          threadContexts.set(sentMessage.message_id, updatedContext);
        }

        amplitudeClient.track({
          event_type: "conversation_completed",
          user_id: ctx.from?.id.toString(),
          user_properties: {
            username: ctx.from?.username || "unknown",
          },
          event_properties: {
            teamId: TEAM_ID,
            question,
            source: "telegram",
            answer: fullResponse,
            chat_id: ctx.chat?.id || "unknown",
            chat_type: ctx.chat?.type || "unknown",
          },
        });

        return;
      }

      fullResponse += response.content;
    }
  } catch (error) {
    if (typingInterval) {
      clearInterval(typingInterval);
    }
    console.error("Error in stream response:", error);
    await ctx.reply(
      "Sorry, something went wrong while generating the response.",
      {
        reply_parameters: {
          message_id: ctx.message?.message_id ?? 0,
        },
        parse_mode: "Markdown",
      } as any
    );
  } finally {
    if (typingInterval) {
      clearInterval(typingInterval);
    }
  }
}

export const handleEnableCommand = async (ctx: Context): Promise<void> => {
  try {
    if (ctx.chat?.type !== "supergroup") {
      await ctx.reply("This command is only available in supergroups.");
      return;
    }

    const isAdmin = await isGroupAdmin(ctx);
    if (!isAdmin) {
      await ctx.reply("Only group administrators can enable the bot.");
      return;
    }

    const threadId = ctx.msg?.isAccessible()
      ? ctx.msg.is_topic_message
        ? ctx.msg.message_thread_id
        : null
      : null;

    const result = await pool.query(
      `INSERT INTO telegram_allowed_supergroups (chat_id, thread_id, enabled_by, enabled)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (chat_id, thread_id) 
       DO UPDATE SET enabled_by = $3, enabled = true
       RETURNING *`,
      [ctx.chat.id, threadId, ctx.from?.id]
    );

    if (result.rows.length > 0) {
      await ctx.reply(
        threadId
          ? "Bot has been enabled for this topic."
          : "Bot has been enabled for this supergroup."
      );
    } else {
      console.error("Failed to add supergroup to database", result);
      await ctx.reply("Failed to enable the bot");
    }
  } catch (error) {
    console.error("Error in enable command:", error);
    await ctx.reply("Failed to enable the bot.");
  }
};

export const handleDisableCommand = async (ctx: Context): Promise<void> => {
  try {
    if (ctx.chat?.type !== "supergroup") {
      await ctx.reply("This command is only available in supergroups.");
      return;
    }

    const isAdmin = await isGroupAdmin(ctx);
    if (!isAdmin) {
      await ctx.reply("Only group administrators can disable the bot.");
      return;
    }

    const threadId = ctx.msg?.isAccessible()
      ? ctx.msg.is_topic_message
        ? ctx.msg.message_thread_id
        : null
      : null;

    await pool.query(
      `UPDATE telegram_allowed_supergroups 
       SET enabled = false 
       WHERE chat_id = $1 
       AND (thread_id = $2 OR (thread_id IS NULL AND $2 IS NULL))`,
      [ctx.chat.id, threadId]
    );

    await ctx.reply(
      threadId
        ? "Bot has been disabled for this topic."
        : "Bot has been disabled for this supergroup."
    );
  } catch (error) {
    console.error("Error in disable command:", error);
    await ctx.reply("Failed to disable the bot.");
  }
};
