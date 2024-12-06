import { Message, Events, ThreadChannel, TextChannel } from "discord.js";
import { discordClient } from "../initalizers/discord";
import { generateConversationResponse, getTeamData } from "./conversation";
import { checkRateLimit } from "../utils/messageLimiter";

const TEAM_ID = "56917ba2-9084-40c3-b9cf-67cd30cc389a";
const MESSAGE_CHUNK_SIZE = 1900;

const conversations = new Map<string, any[]>();

const allowedChannels = new Set<string>();

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  if (!allowedChannels.has(message.channelId)) {
    return;
  }

  const { limited, ttl } = await checkRateLimit(
    message.author.id,
    true // Discord users are authenticated
  );

  if (limited) {
    await message.reply(
      `You've reached the message limit. Please try again in ${Math.ceil(
        ttl || 0
      )} seconds.`
    );
    return;
  }

  const isInThread = message.channel instanceof ThreadChannel;
  const isBotMentioned = message.mentions.has(discordClient.user!.id);

  if (!isInThread && !isBotMentioned) {
    return;
  }

  try {
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
    const messages = await thread.messages.fetch({ limit: 10 });
    const orderedMessages = Array.from(messages.values()).reverse();

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

  if (thread && "sendTyping" in message.channel) {
    await message.channel.sendTyping();
  }
  if ("sendTyping" in targetChannel) {
    await targetChannel.sendTyping();
  }

  try {
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
  } finally {
    if (thread && message.channel instanceof TextChannel) {
      await message.channel.sendTyping().catch(() => {});
    }
    if ("sendTyping" in targetChannel) {
      await targetChannel.sendTyping().catch(() => {});
    }
  }
}

export async function registerCommands(client: any) {
  const commands = [
    {
      name: "enable",
      description: "Enable bot responses in this channel",
    },
    {
      name: "disable",
      description: "Disable bot responses in this channel",
    },
  ];

  await client.application?.commands.set(commands);
}

export async function handleSlashCommand(interaction: any) {
  if (!interaction.memberPermissions?.has("Administrator")) {
    await interaction.reply({
      content: "Only administrators can manage bot channels.",
      ephemeral: true,
    });
    return;
  }

  const channelId = interaction.channelId;

  switch (interaction.commandName) {
    case "enable":
      allowedChannels.add(channelId);
      await interaction.reply({
        content: "Bot enabled in this channel!",
        ephemeral: true,
      });
      break;
    case "disable":
      allowedChannels.delete(channelId);
      await interaction.reply({
        content: "Bot disabled in this channel!",
        ephemeral: true,
      });
      break;
  }
}
