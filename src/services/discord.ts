import { Message, ThreadChannel, TextChannel } from "discord.js";
import { discordClient } from "../initalizers/discord";
import {
  generateConversationResponse,
  getTeamData,
  findRelevantContext,
} from "./conversation";
import { checkRateLimit } from "../utils/messageLimiter";
import { pool } from "../initalizers/postgres";
import { amplitudeClient } from "../initalizers/amplitude";
import { scheduleJob } from "node-schedule";

const TEAM_ID = "56917ba2-9084-40c3-b9cf-67cd30cc389a";

const conversations = new Map<string, any[]>();
const MESSAGE_QUEUE: Message[] = [];
const RELEVANCY_THRESHOLD = 5;
const QUEUE_PROCESS_INTERVAL = '*/2.5 * * * *'; // Runs every 2.5 minutes

const DISCLAIMER_NOTE = ""; // Add empty string for now since we don't know the actual content
const BLACKLIST_KEYWORDS: string[] = []; // Add empty array since we don't know the actual keywords
const OLAS_KEYWORDS: string[] = []; // Add empty array since we don't know the actual keywords

interface SurroundingMessage {
  content: string;
  author: string;
  isReplyTo: boolean;
}

async function isConversationBetweenUsers(message: Message): Promise<boolean> {
  try {
    if (message.reference?.messageId) {
      const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
      if (!repliedMessage.author.bot) {
        return true;
      }
    }

    const recentMessages = await message.channel.messages.fetch({ limit: 4, before: message.id });
    const orderedMessages = Array.from(recentMessages.values());

    let userIds = new Set<string>();
    let consecutiveUserMessages = 0;

    userIds.add(message.author.id);

    for (const msg of orderedMessages) {
      if (msg.author.bot) continue;
      
      userIds.add(msg.author.id);
      
      if (msg.author.id === message.author.id) {
        consecutiveUserMessages++;
      }
      
      if (userIds.size >= 2 && orderedMessages.filter(m => !m.author.bot).length >= 2) {
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error("Error checking conversation pattern:", error);
    return false;
  }
}

async function isMessageOlasRelated(content: string): Promise<boolean> {
  const normalizedContent = content.toLowerCase();
  
  // Check if message contains any Olas-specific keywords
  const hasOlasKeywords = OLAS_KEYWORDS.some(keyword => normalizedContent.includes(keyword.toLowerCase()));
  
  // For messages without clear indicators, default to false
  return false;
}

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  // Only proceed if message is in a thread or in a text channel where we can create a thread
  if (!(message.channel instanceof ThreadChannel) && !(message.channel instanceof TextChannel)) {
    return;
  }

  // Check channel permissions first to avoid unnecessary processing
  const isAllowedChannel =
    (await isChannelAllowed(message.channelId)) ||
    (message.channel instanceof ThreadChannel &&
      message.channel.parentId &&
      (await isChannelAllowed(message.channel.parentId)));

  if (!isAllowedChannel) {
    return;
  }

  // Add message to queue for batch processing
  MESSAGE_QUEUE.push(message);
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
  thread?: ThreadChannel,
  responseGenerator?: AsyncGenerator<any>
): Promise<void> {
  const targetChannel = thread || (message.channel as any);
  let lastMessage: Message | null = null;

  if (thread && "sendTyping" in message.channel) {
    await message.channel.sendTyping();
  }
  if ("sendTyping" in targetChannel) {
    await targetChannel.sendTyping();
  }

  try {
    const cleanContent = message.content.replace(/<@!\d+>|<@\d+>/g, "").trim();
    let isLastChunk = false;
    let accumulatedContent = "";

    for await (const response of responseGenerator!) {
      if (response.error) {
        console.error("Response error:", response.error);
        return; // Silently fail instead of sending error message
      }

      accumulatedContent += response.content || "";
      isLastChunk = response.done || false;

      if (isLastChunk || accumulatedContent.length >= 1800) {
        // Find a good splitting point
        let splitIndex = accumulatedContent.length;
        if (accumulatedContent.length > 1800) {
          const breakPoints = [
            ...accumulatedContent.matchAll(/[.!?]\s+(?=[A-Z])/g), // Sentence endings
            ...accumulatedContent.matchAll(/\n(?=[#\-\d])/g),     // New lines before sections
            ...accumulatedContent.matchAll(/:\s*\n/g),            // Lines ending with colon
            ...accumulatedContent.matchAll(/[.!?]\s+/g),          // Any sentence ending
            ...accumulatedContent.matchAll(/,\s+/g),              // Comma breaks as last resort
          ].map(match => match.index).filter(index => index !== undefined && index < 1800);

          if (breakPoints.length > 0) {
            splitIndex = Math.max(...breakPoints as number[]) + 1;
          } else {
            // If no good breaking point, use word boundary
            splitIndex = accumulatedContent.lastIndexOf(' ', 1800);
            if (splitIndex === -1) splitIndex = 1800;
          }
        }

        const contentToSend = accumulatedContent.slice(0, splitIndex).trim() + 
                            (isLastChunk && splitIndex === accumulatedContent.length ? DISCLAIMER_NOTE : "");

        try {
          if (!lastMessage) {
            lastMessage = await targetChannel.send({ content: contentToSend });
          } else {
            lastMessage = await targetChannel.send({
              content: contentToSend,
              reply: { messageReference: lastMessage.id, failIfNotExists: false }
            });
          }

          accumulatedContent = accumulatedContent.slice(splitIndex).trim();
        } catch (error) {
          console.error("Message send error:", error);
          lastMessage = await targetChannel.send({ content: contentToSend });
          accumulatedContent = accumulatedContent.slice(splitIndex).trim();
        }
      }
    }

    // Send any remaining content
    if (accumulatedContent.trim().length > 0) {
      const finalContent = accumulatedContent.trim() + DISCLAIMER_NOTE;
      try {
        if (lastMessage) {
          await targetChannel.send({
            content: finalContent,
            reply: { messageReference: lastMessage.id, failIfNotExists: false }
          });
        } else {
          await targetChannel.send({ content: finalContent });
        }
      } catch (error) {
        console.error("Final chunk send error:", error);
        await targetChannel.send({ content: finalContent });
      }
    }
  } catch (error: any) {
    console.error("StreamResponse error:", error);
    return; // Silently fail instead of sending error message
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
  try {
    // Immediately defer the reply
    await interaction.deferReply({ ephemeral: true });

    if (!interaction.memberPermissions?.has("Administrator")) {
      await interaction.editReply({
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

        await interaction.editReply({
          content: "Bot enabled in this channel!",
          ephemeral: true,
        });
        break;

      case "disable":
        await pool.query(
          "DELETE FROM discord_allowed_channels WHERE channel_id = $1",
          [channelId]
        );

        await interaction.editReply({
          content: "Bot disabled in this channel!",
          ephemeral: true,
        });
        break;
    }
  } catch (error) {
    console.error("Error in handleSlashCommand:", error);
    try {
      const errorMessage =
        "Sorry, something went wrong while processing your command.";
      if (interaction.deferred) {
        await interaction.editReply({ content: errorMessage, ephemeral: true });
      } else if (!interaction.replied) {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    } catch (followUpError) {
      console.error("Error sending error message:", followUpError);
    }
  }
}

async function isChannelAllowed(channelId: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM discord_allowed_channels WHERE channel_id = $1",
    [channelId]
  );
  return result.rows.length > 0;
}

async function processQueuedMessages() {
  if (MESSAGE_QUEUE.length === 0) return;

  const messages = [...MESSAGE_QUEUE];
  MESSAGE_QUEUE.length = 0;

  const teamData = await getTeamData(TEAM_ID);
  const BATCH_SIZE = 10;

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);

    try {
      const messagesToProcess = await Promise.all(
        batch.map(async (message) => {
          try {
            if (await isConversationBetweenUsers(message)) {
              return null;
            }

            const isBotMentioned = message.mentions.has(discordClient.user!.id);
            let messageContent = message.content.toLowerCase();

            const previousMessage = await getPreviousMessage(message);
            const contentToCheck = previousMessage ? 
              previousMessage.content.toLowerCase() : 
              messageContent;

            if (BLACKLIST_KEYWORDS.some(keyword => contentToCheck.includes(keyword))) {
              return null;
            }

            const isOlasRelated = await isMessageOlasRelated(contentToCheck);
            
            if (!isOlasRelated && !isBotMentioned) {
              return null;
            }

            const channel = message.channel;
            let surroundingMessages: SurroundingMessage[] = [];
            let replyMessage: any = null;

            if ("messages" in channel) {
              if (message.reference?.messageId) {
                try {
                  replyMessage = await channel.messages.fetch(
                    message.reference.messageId
                  );
                  if (replyMessage) {
                    let updatedMessageContent = `[Replying to ${replyMessage.author.username}: "${replyMessage.content}"] ${message.content}`;
                    messageContent = updatedMessageContent;
                    surroundingMessages.push({
                      content: replyMessage.content,
                      author: replyMessage.author.username,
                      isReplyTo: true,
                    });
                  }
                } catch (error) {
                  console.error("Error fetching reply message:", error);
                }
              }

              const previousMessages = await channel.messages.fetch({
                limit: 7,
                before: message.id,
              });

              const previousContext = previousMessages
                .filter((msg) => msg.id !== replyMessage?.id)
                .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
                .map((msg) => ({
                  content: msg.content,
                  author: msg.author.username,
                  isReplyTo: false,
                }));

              surroundingMessages = [
                ...surroundingMessages,
                ...previousContext,
              ];
            }

            const relevantContext = await findRelevantContext(
              messageContent,
              teamData.name,
              "general",
              null,
              undefined,
              surroundingMessages
            );

            const highestScore = relevantContext[0]?.score || 0;

            return { message, relevancyScore: highestScore };
          } catch (error) {
            console.error("Error processing message in batch:", error);
            return null;
          }
        })
      );

      const validMessages = messagesToProcess.filter(result => result !== null);

      for (const messageData of validMessages) {
        if (messageData) {
          try {
            await processMessage(messageData.message);
          } catch (error) {
            console.error("Error processing valid message:", error);
          }
        }
      }
    } catch (error) {
      console.error("Error processing batch:", error);
    }

    if (i + BATCH_SIZE < messages.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export function initializeMessageQueue() {
  scheduleJob(QUEUE_PROCESS_INTERVAL, async () => {
    try {
      await processQueuedMessages();
    } catch (error) {
      console.error("Error processing message queue:", error);
    }
  });
}

async function processMessage(
  message: Message,
  useRateLimit: boolean = true
): Promise<void> {
  try {
    const { limited, ttl } = await checkRateLimit(message.author.id, true);

    if (limited && useRateLimit) {
      await message.reply(
        `You've reached the message limit. Please try again in ${Math.ceil(
          ttl || 0
        )} seconds.`
      );
      return;
    }

    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping();
    }

    const teamData = await getTeamData(TEAM_ID);
    const conversationId = message.channelId;
    const conversationHistory = getOrCreateConversation(conversationId);

    updateConversationHistory(conversationHistory, {
      role: "user",
      content: message.content,
    });

    const typingInterval = setInterval(() => {
      if ("sendTyping" in message.channel) {
        message.channel.sendTyping().catch(console.error);
      }
    }, 5000);

    try {
      let responseStream = generateConversationResponse(
        message.content,
        conversationHistory,
        teamData,
        "general",
        null,
        false
      );

      const firstChunk = await responseStream.next();
      if (firstChunk.value?.error) {
        clearInterval(typingInterval);
        console.error("Error generating response:", firstChunk.value.error);
        console.error("Response generation failed with error:", {
          error: firstChunk.value.error,
          message: message.content,
          author: message.author.username
        });
        return;
      }

      let thread: ThreadChannel | undefined;
      
      if (message.hasThread && message.thread) {
        thread = message.thread as ThreadChannel;
      } else if (message.channel instanceof TextChannel) {
        try {
          const cleanTitle = message.content
            .replace(/<@!?\d+>/g, '')
            .replace(/<@&\d+>/g, '')
            .replace(/<#\d+>/g, '')
            .replace(/\s*<@&?\d+>\s*/g, ' ')
            .replace(/\s*<[#@][!&]?\d+>\s*/g, ' ')
            .replace(/\s*\d{17,19}\s*/g, ' ')
            .trim()
            .slice(0, 50);

          const userMention = `@${message.author.username}`;
          thread = await message.startThread({
            name: `${userMention} ${cleanTitle}`,
            autoArchiveDuration: 60,
          });
        } catch (error: any) {
          if (error.code === 'MessageExistingThread' && message.thread) {
            thread = message.thread as ThreadChannel;
          } else {
            throw error;
          }
        }
      }

      if (thread) {
        await loadThreadHistory(thread, conversationHistory);
      }

      const fullResponse = (async function* () {
        yield firstChunk.value;
        for await (const chunk of responseStream) {
          yield chunk;
        }
      })();

      const targetChannel = thread || message.channel;
      await streamResponse(
        message,
        conversationHistory,
        teamData,
        thread,
        fullResponse
      );
    } catch (error) {
      console.error("Error in response generation:", error);
      console.error("Message processing failed:", {
        error,
        message: message.content,
        author: message.author.username,
        channelId: message.channelId
      });
      throw error;
    } finally {
      clearInterval(typingInterval);
    }
  } catch (error) {
    console.error("Fatal error in message processing:", {
      error,
      message: message.content,
      author: message.author.username,
      channelId: message.channelId
    });
    return;
  }
}

async function getPreviousMessage(message: Message): Promise<Message | null> {
  if (message.reference?.messageId && "messages" in message.channel) {
    try {
      return await message.channel.messages.fetch(message.reference.messageId);
    } catch (error) {
      console.error("Error fetching previous message:", error);
      return null;
    }
  }
  return null;
}
