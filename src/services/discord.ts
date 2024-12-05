import { Message, Events, ThreadChannel, TextChannel } from "discord.js";
import { discordClient } from "../initalizers/discord";
import { generateConversationResponse, getTeamData } from "./conversation";

const TEAM_ID = "56917ba2-9084-40c3-b9cf-67cd30cc389a";
const MESSAGE_CHUNK_SIZE = 1900;

// Store ongoing conversations
const conversations = new Map<string, any[]>();

export async function handleMessage(message: Message): Promise<void> {
  // Ignore bot messages
  if (message.author.bot) return;

  // Check if message is in a thread or mentions the bot
  const isInThread = message.channel instanceof ThreadChannel;
  const isBotMentioned = message.mentions.has(discordClient.user!.id);

  // Only proceed if message is in a thread or mentions the bot
  if (!isInThread && !isBotMentioned) return;

  try {
    // Remove the bot mention from the message content if present
    const content = message.content.replace(/<@!\d+>|<@\d+>/g, "").trim();

    const conversationId =
      message.channel instanceof ThreadChannel
        ? message.channel.id
        : message.channelId;

    const conversationHistory = getOrCreateConversation(conversationId);

    if (isInThread) {
      await loadThreadHistory(message.channel, conversationHistory);
    }

    updateConversationHistory(conversationHistory, {
      role: "user",
      content,
    });

    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping();
    }

    const teamData = await getTeamData(TEAM_ID);

    if (message.channel instanceof TextChannel && !message.hasThread) {
      const thread = await message.startThread({
        name: `Chat: ${content.slice(0, 50)}...`,
        autoArchiveDuration: 60,
      });
      await streamResponse(message, conversationHistory, teamData, thread);
    } else {
      await streamResponse(message, conversationHistory, teamData);
    }
  } catch (error) {
    console.error("Error handling message:", error);
    await message.reply(
      "Sorry, something went wrong while processing your message."
    );
  }
}

export async function loadThreadHistory(
  thread: ThreadChannel,
  conversationHistory: any[]
): Promise<void> {
  try {
    // Fetch last 10 messages from thread
    const messages = await thread.messages.fetch({ limit: 10 });
    const orderedMessages = Array.from(messages.values()).reverse();

    // Clear existing history and rebuild from thread
    conversationHistory.length = 0;

    for (const msg of orderedMessages) {
      if (!msg.author.bot) {
        conversationHistory.push({
          role: "user",
          content: msg.content,
        });
      } else if (msg.author.id === discordClient.user?.id) {
        conversationHistory.push({
          role: "assistant",
          content: msg.content,
        });
      }
    }
  } catch (error) {
    console.error("Error loading thread history:", error);
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
  message: Message,
  conversationHistory: any[],
  teamData: any,
  thread?: ThreadChannel
): Promise<void> {
  const targetChannel = thread || (message.channel as any);
  let fullResponse = "";

  for await (const response of generateConversationResponse(
    message.content,
    conversationHistory,
    teamData,
    false
  )) {
    if (response.error) {
      await targetChannel.send(
        "Sorry, I encountered an error while processing your request."
      );
      return;
    }

    if (response.done) {
      updateConversationHistory(conversationHistory, {
        role: "assistant",
        content: fullResponse,
      });
      await targetChannel.send(fullResponse);
      return;
    }

    fullResponse += response.content;
  }
}
