import { Message, ThreadChannel, TextChannel } from "discord.js";
import { discordClient } from "../initalizers/discord";
import { generateConversationResponse, getTeamData } from "./conversation";
import { checkRateLimit } from "../utils/messageLimiter";
import { pool } from "../initalizers/postgres";

const TEAM_ID = "56917ba2-9084-40c3-b9cf-67cd30cc389a";

const conversations = new Map<string, any[]>();

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  const isBotMentioned = message.mentions.has(discordClient.user!.id);
  if (!isBotMentioned) return;

  const isAllowedChannel =
    (await isChannelAllowed(message.channelId)) ||
    (message.channel instanceof ThreadChannel &&
      message.channel.parentId &&
      (await isChannelAllowed(message.channel.parentId)));

  if (!isAllowedChannel) {
    console.log("not allowed channel", message.channelId);
    return;
  }

  const { limited, ttl } = await checkRateLimit(message.author.id, true);

  if (limited) {
    await message.reply(
      `You've reached the message limit. Please try again in ${Math.ceil(
        ttl || 0
      )} seconds.`
    );
    return;
  }

  try {
    const content = message.content.replace(/<@!\d+>|<@\d+>/g, "").trim();
    const conversationId =
      message.channel instanceof ThreadChannel
        ? message.channel.id
        : message.channelId;

    const conversationHistory = getOrCreateConversation(conversationId);

    if (message.channel instanceof ThreadChannel) {
      await loadThreadHistory(message.channel, conversationHistory);
    } else {
      conversationHistory.length = 0;
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
      const threadName =
        content.length > 50 ? `${content.slice(0, 50)}...` : content;

      const thread = await message.startThread({
        name: `Chat: ${threadName}`,
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
  } catch (error) {
    console.error("Error in streamResponse:", error);
    await targetChannel.send(
      "Sorry, something went wrong while processing your message."
    );
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
  const serverId = interaction.guildId;
  const enabledBy = interaction.user.id;

  switch (interaction.commandName) {
    case "enable":
      await pool.query(
        `INSERT INTO discord_servers (id) 
         VALUES ($1) 
         ON CONFLICT (id) DO NOTHING`,
        [serverId]
      );

      await pool.query(
        `INSERT INTO discord_allowed_channels (channel_id, server_id, enabled_by) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (channel_id) DO NOTHING`,
        [channelId, serverId, enabledBy]
      );

      await interaction.reply({
        content: "Bot enabled in this channel!",
        ephemeral: true,
      });
      break;

    case "disable":
      await pool.query(
        "DELETE FROM discord_allowed_channels WHERE channel_id = $1",
        [channelId]
      );

      await interaction.reply({
        content: "Bot disabled in this channel!",
        ephemeral: true,
      });
      break;
  }
}

async function isChannelAllowed(channelId: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM discord_allowed_channels WHERE channel_id = $1",
    [channelId]
  );
  return result.rows.length > 0;
}
