import { Context } from "telegraf";

import { generateConversationResponse, getTeamData } from "./conversation";

const TEAM_ID = "56917ba2-9084-40c3-b9cf-67cd30cc389a";
const ENABLE_TYPING_DELAY = process.env.ENABLE_TYPING_DELAY === "true";

// Store ongoing conversations
const conversations = new Map<string, any[]>();

export async function handleTelegramMessage(ctx: Context): Promise<void> {
  // Ignore messages without text
  if (!ctx.message || !("text" in ctx.message)) return;

  // Only respond to messages that mention the bot or are direct messages
  const isBotMention = ctx.message.text.includes(`@${ctx.botInfo.username}`);
  const isDirectMessage = ctx.chat?.type === "private";

  if (!isBotMention && !isDirectMessage) return;

  try {
    // Remove bot mention from message
    const content = ctx.message.text
      .replace(`@${ctx.botInfo.username}`, "")
      .trim();
    const conversationId = ctx.chat?.id.toString();

    if (!conversationId) return;

    const conversationHistory = getOrCreateConversation(conversationId);

    updateConversationHistory(conversationHistory, {
      role: "user",
      content,
    });

    if (ENABLE_TYPING_DELAY && ctx.chat?.id) {
      await ctx.telegram.sendChatAction(ctx.chat.id, "typing");
    }

    const teamData = await getTeamData(TEAM_ID);
    await streamResponse(ctx, content, conversationHistory, teamData);
  } catch (error) {
    console.error("Error handling message:", error);
    await ctx.reply(
      "Sorry, something went wrong while processing your message."
    );
  }
}

function getOrCreateConversation(conversationId: string): any[] {
  if (!conversations.has(conversationId)) {
    conversations.set(conversationId, []);
  }
  return conversations.get(conversationId)!;
}

function updateConversationHistory(
  history: any[],
  message: { role: string; content: string }
): void {
  history.push(message);
  if (history.length > 10) {
    history.splice(0, history.length - 10);
  }
}

async function streamResponse(
  ctx: Context,
  question: string,
  conversationHistory: any[],
  teamData: any
): Promise<void> {
  let fullResponse = "";
  let typingInterval: NodeJS.Timeout | undefined;

  try {
    // Start continuous typing indicator
    if (ENABLE_TYPING_DELAY && ctx.chat?.id) {
      typingInterval = setInterval(async () => {
        await ctx.telegram.sendChatAction(ctx.chat!.id, "typing");
      }, 4000);
    }

    for await (const response of generateConversationResponse(
      question,
      conversationHistory,
      teamData,
      !ENABLE_TYPING_DELAY
    )) {
      if (response.error) {
        clearInterval(typingInterval);
        await ctx.reply(
          "Sorry, I encountered an error while processing your request."
        );
        return;
      }

      if (response.done) {
        clearInterval(typingInterval);
        updateConversationHistory(conversationHistory, {
          role: "assistant",
          content: fullResponse,
        });
        await ctx.reply(fullResponse);
        return;
      }

      fullResponse += response.content;
    }
  } catch (error) {
    clearInterval(typingInterval);
    console.error("Error in stream response:", error);
    await ctx.reply(
      "Sorry, something went wrong while generating the response."
    );
  }
}
