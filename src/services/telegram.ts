import { Context } from "telegraf";

import { generateConversationResponse, getTeamData } from "./conversation";
import { checkRateLimit } from "../utils/messageLimiter";

const TEAM_ID = "56917ba2-9084-40c3-b9cf-67cd30cc389a";

const threadContexts = new Map<number, any[]>();

function formatThreadContextForAI(threadContext: any[]): any[] {
  return threadContext.map((msg) => ({
    role: msg.from?.is_bot ? "assistant" : "user",
    content: msg.text?.replace(/@\w+/g, "").trim() || "",
  }));
}

export async function handleTelegramMessage(ctx: Context): Promise<void> {
  try {
    if (!ctx.botInfo) {
      console.error("Bot not properly initialized");
      return;
    }

    if (!ctx.message || !("text" in ctx.message)) {
      return;
    }

    const isPrivateChat = ctx.chat?.type === "private";
    const isBotMention = ctx.message.text.includes(`@${ctx.botInfo.username}`);

    if (!isPrivateChat && !isBotMention) return;

    const userId = ctx.from?.id.toString();
    if (!userId) return;

    const replyToMessageId = ctx.message.reply_to_message?.message_id;
    const currentMessageId = ctx.message.message_id;

    let threadContext: any[] = [];

    if (replyToMessageId) {
      threadContext = threadContexts.get(replyToMessageId) || [];
    }

    threadContext.push(ctx.message);

    threadContexts.set(currentMessageId, threadContext);

    const formattedContext = formatThreadContextForAI(threadContext);

    if (ctx.chat?.id) {
      await ctx.telegram.sendChatAction(ctx.chat.id, "typing");
    }

    const teamData = await getTeamData(TEAM_ID);
    await streamResponse(
      ctx,
      ctx.message.text.replace(`@${ctx.botInfo.username}`, "").trim(),
      formattedContext,
      teamData,
      threadContext,
      replyToMessageId
    );
  } catch (error) {
    console.error("Error handling message:", error);
    try {
      await ctx.reply(
        "Sorry, something went wrong while processing your message."
      );
    } catch (replyError) {
      console.error("Failed to send error message:", replyError);
    }
  }
}

async function streamResponse(
  ctx: Context,
  question: string,
  conversationHistory: any[],
  teamData: any,
  threadContext: any[],
  replyToMessageId?: number
): Promise<void> {
  let fullResponse = "";
  let typingInterval: NodeJS.Timeout | undefined;

  try {
    if (ctx.chat?.id) {
      typingInterval = setInterval(async () => {
        await ctx.telegram.sendChatAction(ctx.chat!.id, "typing");
      }, 4000);
    }

    for await (const response of generateConversationResponse(
      question,
      conversationHistory,
      teamData,
      false
    )) {
      if (response.error) {
        clearInterval(typingInterval);
        await ctx.telegram.sendMessage(
          ctx.chat!.id,
          "Sorry, I encountered an error while processing your request.",
          {
            reply_parameters: {
              message_id: replyToMessageId ?? ctx.message?.message_id ?? 0,
            },
          }
        );
        return;
      }

      if (response.done) {
        clearInterval(typingInterval);

        const sentMessage = await ctx.reply(fullResponse, {
          reply_parameters: {
            message_id: replyToMessageId ?? ctx.message?.message_id ?? 0,
          },
        });

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

        return;
      }

      fullResponse += response.content;
    }
  } catch (error) {
    clearInterval(typingInterval);
    console.error("Error in stream response:", error);
    await ctx.reply(
      "Sorry, something went wrong while generating the response.",
      {
        reply_parameters: {
          message_id: replyToMessageId ?? ctx.message?.message_id ?? 0,
        },
      }
    );
  }
}
