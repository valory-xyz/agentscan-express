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
const QUEUE_PROCESS_INTERVAL = "*/10 * * * * *"; // Runs every 1 minute

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  const isBotMentioned = message.mentions.has(discordClient.user!.id);
  const isAllowedChannel =
    (await isChannelAllowed(message.channelId)) ||
    (message.channel instanceof ThreadChannel &&
      message.channel.parentId &&
      (await isChannelAllowed(message.channel.parentId)));

  if (!isAllowedChannel) {
    console.log("not allowed channel", message.channelId);
    return;
  }

  if (isBotMentioned) {
    await processMessage(message);
  } else if (
    !(message.channel instanceof ThreadChannel) &&
    message.mentions.users.size === 0 // Only add messages without user mentions
  ) {
    MESSAGE_QUEUE.push(message);
    console.log("Message added to queue:", message.id);
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
  let currentChunk = "";
  let lastMessage: Message | null = message; // Initialize with original message

  if (thread && "sendTyping" in message.channel) {
    await message.channel.sendTyping();
  }
  if ("sendTyping" in targetChannel) {
    await targetChannel.sendTyping();
  }

  try {
    const cleanContent = message.content.replace(/<@!\d+>|<@\d+>/g, "").trim();

    for await (const response of generateConversationResponse(
      cleanContent,
      conversationHistory,
      teamData,
      "general",
      null,
      false
    )) {
      if (response.error) {
        await targetChannel.send({
          content:
            "Sorry, I encountered an error while processing your request.",
          reply: { messageReference: lastMessage?.id },
        });
        return;
      }

      fullResponse += response.content || "";
      currentChunk += response.content || "";

      if (currentChunk.length >= 1600 || response.done) {
        let splitIndex = currentChunk.length;
        const breakPoints = [
          currentChunk.lastIndexOf(". "),
          currentChunk.lastIndexOf("?\n"),
          currentChunk.lastIndexOf("!\n"),
          currentChunk.lastIndexOf("\n#"),
          currentChunk.lastIndexOf("\n##"),
          currentChunk.lastIndexOf("\n###"),
        ].filter((i) => i !== -1 && i < 1900);

        if (breakPoints.length > 0) {
          splitIndex = Math.max(...breakPoints) + 1;
        }

        try {
          lastMessage = await targetChannel.send({
            content: currentChunk.slice(0, splitIndex).trim(),
            reply: { messageReference: lastMessage?.id },
          });
          currentChunk = currentChunk.slice(splitIndex);
        } catch (error) {
          console.error("Error sending message:", error);
          throw error;
        }
      }
    }

    if (currentChunk.trim().length > 0) {
      await targetChannel.send({
        content: currentChunk.trim(),
        reply: { messageReference: lastMessage?.id },
      });
    }
  } catch (error) {
    console.error("Error in streamResponse:", error);
    await targetChannel.send({
      content: "Sorry, something went wrong while processing your message.",
      reply: { messageReference: message.id },
    });
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
  MESSAGE_QUEUE.length = 0; // Clear the queue
  console.log("Processing messages:", messages.length);

  const teamData = await getTeamData(TEAM_ID);
  const BATCH_SIZE = 10;

  // Process messages in batches
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);

    try {
      // Process each batch concurrently
      const relevancyChecks = await Promise.all(
        batch.map(async (message) => {
          try {
            const channel = message.channel;
            let surroundingMessages: {
              content: string;
              author: string;
              isReplyTo?: boolean;
            }[] = [];
            let messageContent = message.content;
            let replyMessage: any = null;

            if ("messages" in channel) {
              // Add reply context to the message content if it exists
              if (message.reference?.messageId) {
                try {
                  replyMessage = await channel.messages.fetch(
                    message.reference.messageId
                  );
                  if (replyMessage) {
                    messageContent = `[Replying to ${replyMessage.author.username}: "${replyMessage.content}"] ${message.content}`;
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

              // Fetch previous messages
              const previousMessages = await channel.messages.fetch({
                limit: 7,
                before: message.id,
              });

              // Add previous messages, excluding the reply message if it exists
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
              console.log("Surrounding messages:", surroundingMessages);
            }

            const relevantContext = await findRelevantContext(
              messageContent,
              teamData.name,
              "general",
              null,
              undefined,
              surroundingMessages
            );
            console.log(
              "Relevant context for message:",
              message.id,
              relevantContext
            );

            // Get the highest relevancy score from the context
            const highestScore = Math.max(
              ...relevantContext.map((context) => context.score || 0)
            );

            return {
              message,
              relevancyScore: highestScore,
            };
          } catch (error) {
            console.error(
              "Error checking relevancy for message:",
              message.id,
              error
            );
            return { message, relevancyScore: 0 };
          }
        })
      );

      const relevantMessages = relevancyChecks.filter(
        (result) => result.relevancyScore >= RELEVANCY_THRESHOLD
      );
      console.log("Relevant messages in batch:", relevantMessages.length);

      // Process relevant messages in this batch sequentially
      for (const { message } of relevantMessages) {
        try {
          await processMessage(message);
        } catch (error) {
          console.error("Error processing message:", message.id, error);
        }
      }
    } catch (error) {
      console.error("Error processing batch:", error);
    }

    // Optional: Add a small delay between batches to prevent rate limiting
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
  const { limited, ttl } = await checkRateLimit(message.author.id, true);

  if (limited && useRateLimit) {
    await message.reply(
      `You've reached the message limit. Please try again in ${Math.ceil(
        ttl || 0
      )} seconds.`
    );
    return;
  }

  try {
    const teamData = await getTeamData(TEAM_ID);
    let thread: ThreadChannel | undefined;

    // Create or get thread if in a text channel
    if (message.channel instanceof TextChannel) {
      thread = await message.startThread({
        name: message.content.slice(0, 100), // Discord has a 100-char limit for thread names
        autoArchiveDuration: 60,
      });
    }

    const conversationId = thread?.id || message.channelId;
    const conversationHistory = getOrCreateConversation(conversationId);

    if (thread) {
      await loadThreadHistory(thread, conversationHistory);
    }

    // Track the user message in conversation history
    updateConversationHistory(conversationHistory, {
      role: "user",
      content: message.content,
    });

    amplitudeClient.track({
      event_type: "conversation_made",
      user_id: message.author.id,
      user_properties: {
        username: message.author.username,
      },
      event_properties: {
        teamId: TEAM_ID,
        question: message.content,
        source: "discord",
        messages: conversationHistory,
        channel_id: message.channelId,
        channel_type: message.channel.type,
        guild_id: message.guildId || "DM",
      },
    });

    await streamResponse(message, conversationHistory, teamData, thread);
  } catch (error) {
    console.error("Error handling message:", error);
    await message.reply(
      "Sorry, something went wrong while processing your message."
    );
  }
}
