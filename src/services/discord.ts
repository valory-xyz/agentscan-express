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
  thread?: ThreadChannel,
  responseGenerator?: AsyncGenerator<any>
): Promise<void> {
  const targetChannel = thread || (message.channel as any);
  let fullResponse = "";
  let currentChunk = "";
  let lastMessage: Message | null = null; // Start without a reference

  if (thread && "sendTyping" in message.channel) {
    await message.channel.sendTyping();
  }
  if ("sendTyping" in targetChannel) {
    await targetChannel.sendTyping();
  }

  try {
    const cleanContent = message.content.replace(/<@!\d+>|<@\d+>/g, "").trim();

    for await (const response of responseGenerator!) {
      if (response.error) {
        console.error("Response error:", response.error);
        await targetChannel.send({
          content: `Error: ${response.error}`,
        });
        return;
      }

      fullResponse += response.content || "";
      currentChunk += response.content || "";

      if (currentChunk.length >= 1500 || response.done) {
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
          // Send first message without reply
          if (!lastMessage) {
            lastMessage = await targetChannel.send({
              content: currentChunk.slice(0, splitIndex).trim(),
            });
          } else {
            // Subsequent messages reply to the last one
            lastMessage = await targetChannel.send({
              content: currentChunk.slice(0, splitIndex).trim(),
              reply: {
                messageReference: lastMessage.id,
                failIfNotExists: false,
              },
            });
          }
          currentChunk = currentChunk.slice(splitIndex);
        } catch (error) {
          console.error("Message send error:", error);
          // Fallback: send without reply
          lastMessage = await targetChannel.send({
            content: currentChunk.slice(0, splitIndex).trim(),
          });
          currentChunk = currentChunk.slice(splitIndex);
        }
      }
    }

    if (currentChunk.trim().length > 0) {
      try {
        if (lastMessage) {
          await targetChannel.send({
            content: currentChunk.trim(),
            reply: { messageReference: lastMessage.id, failIfNotExists: false },
          });
        } else {
          await targetChannel.send({
            content: currentChunk.trim(),
          });
        }
      } catch (error) {
        console.error("Final chunk send error:", error);
        await targetChannel.send({
          content: currentChunk.trim(),
        });
      }
    }
  } catch (error: any) {
    console.error("StreamResponse error:", error);
    await targetChannel.send({
      content:
        error?.message ||
        "An unexpected error occurred while processing your message.",
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
    // Start typing indicator immediately
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

    // Keep typing indicator active during processing
    const typingInterval = setInterval(() => {
      if ("sendTyping" in message.channel) {
        message.channel.sendTyping().catch(console.error);
      }
    }, 5000);

    try {
      // Generate response first
      let responseStream = generateConversationResponse(
        message.content,
        conversationHistory,
        teamData,
        "general",
        null,
        false
      );

      // Check if we have a valid response
      const firstChunk = await responseStream.next();
      if (firstChunk.value?.error) {
        clearInterval(typingInterval);
        console.error("Error generating response:", firstChunk.value.error);
        await message.reply(
          "Sorry, something went wrong while processing your message."
        );
        return;
      }

      let thread: ThreadChannel | undefined;
      if (message.channel instanceof TextChannel) {
        thread = await message.startThread({
          name: message.content.slice(0, 100),
          autoArchiveDuration: 60,
        });
      }

      if (thread) {
        await loadThreadHistory(thread, conversationHistory);
      }

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

      const fullResponse = (async function* () {
        yield firstChunk.value;
        for await (const chunk of responseStream) {
          yield chunk;
        }
      })();

      await streamResponse(
        message,
        conversationHistory,
        teamData,
        thread,
        fullResponse
      );
    } finally {
      // Always clear the typing interval
      clearInterval(typingInterval);
    }
  } catch (error) {
    console.error("Error handling message:", error);
    await message.reply(
      "Sorry, something went wrong while processing your message."
    );
  }
}
