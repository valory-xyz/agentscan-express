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

const STAKING_KEYWORDS = [
  'stake',
  'staking',
  'veolas',
  'lock',
  'locking',
  'validator',
  'validators',
  'delegation',
  'delegate'
];

const STAKING_RESPONSE = "You can stake OLAS tokens through Pearl on Gnosis Chain or through other official contracts. Please visit the Olas Contracts page for the most up-to-date staking information and options: https://contracts.olas.network/";

const DISCLAIMER_NOTE = "\n\nNote: I am an AI bot providing my best attempt at answering your question. Please always verify information in the official Olas documentation to ensure accuracy and up-to-date solutions: https://docs.olas.network/";

const BLACKLIST_KEYWORDS = [
  // Price related
  'market cap',
  'marketcap',
  'how much is',
  'how much are',
  'current price',
  'token price',
  'price prediction',
  'price target',
  // Lost tokens and potential scams
  'lost',
  'lost tokens',
  'lost my tokens',
  'tokens disappeared',
  'disappeared',
  'missing tokens',
  'missing',
  'stolen',
  'stolen tokens',
  'cant find tokens',
  'can\'t find tokens',
  'where are my tokens',
  // Trading related
  'buy',
  'purchase',
  'acquire',
  'get tokens',
  'get coin',
  'get crypto',
  'how do i get',
  'how to get',
  'exchange',
  'trading',
  'trade',
  'swap',
  'invest',
  'investment',
  'how to buy',
  'can i buy',
  'binance',
  'coinbase',
  'uniswap',
  'dex',
  'cex',
  'exchange',
  // Avoid direct staking advice
  'should i stake',
  'worth staking',
  'good to stake',
  'profitable',
  'returns',
  'apy',
  'apr',
  'rewards',
  'earnings',
  'profit'
];

const TECHNICAL_KEYWORDS = [
  'error',
  'bug',
  'issue',
  'problem',
  'fail',
  'failed',
  'failing',
  'exception',
  'warning',
  'debug',
  'testing',
  'test',
  'implementation',
  'integrate',
  'integration',
  'deploy',
  'deployment',
  'transaction',
  'network',
  'command',
  'config',
  'configuration',
  'setup',
  'install',
  'installing',
  'running',
  'execute',
  'execution',
  'mechx',
  'mech',
  'client',
  'gnosis',
  'celo'
];

const OLAS_KEYWORDS = [
  'olas',
  'valory',
  'autonolas',
  'autonomous service',
  'autonomous services',
  'ontology',
  'tokenomics',
  'staking',
  'governance',
  'veolas',
  'registry',
  'service registry',
  'agent service',
  'agent services',
  'component registry',
  'agent',
  'agents',
  'example agent',
  'example agents',
  'olas agent',
  'olas agents'
];

const SETUP_KEYWORDS = [
  'setup',
  'set up',
  'start',
  'getting started',
  'begin',
  'create',
  'make',
  'build',
  'deploy',
  'run',
  'launch',
  'install',
  'guide',
  'tutorial',
  'how to',
  'how do i',
  'help me'
];

const UNRELATED_TOPICS: string[] = [
  // Add any unrelated topics here
];

async function getPreviousMessage(message: Message): Promise<Message | null> {
  // If the message is a reply, get the replied-to message
  if (message.reference?.messageId) {
    try {
      return await message.channel.messages.fetch(message.reference.messageId);
    } catch (error) {
      console.error("Error fetching replied message:", error);
      return null;
    }
  }

  // If message asks about previous message
  const askingAboutPrevious = message.content.toLowerCase().includes('previous') || 
                             message.content.toLowerCase().includes('last message') ||
                             message.content.toLowerCase().includes('solve this') ||
                             message.content.toLowerCase().includes('help with this');

  if (askingAboutPrevious) {
    try {
      const messages = await message.channel.messages.fetch({ limit: 5, before: message.id });
      const previousMessage = messages.find(msg => !msg.author.bot);
      return previousMessage || null;
    } catch (error) {
      console.error("Error fetching previous messages:", error);
      return null;
    }
  }

  return null;
}

async function isConversationBetweenUsers(message: Message): Promise<boolean> {
  try {
    // Check if this is a reply to another user
    if (message.reference?.messageId) {
      const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
      if (!repliedMessage.author.bot) {
        return true;
      }
    }

    // Get recent messages to check for back-and-forth conversation
    const recentMessages = await message.channel.messages.fetch({ limit: 4, before: message.id });
    const orderedMessages = Array.from(recentMessages.values());

    // Check if there's a conversation pattern between users
    let userIds = new Set<string>();
    let consecutiveUserMessages = 0;

    // Add current message author
    userIds.add(message.author.id);

    for (const msg of orderedMessages) {
      if (msg.author.bot) continue;
      
      userIds.add(msg.author.id);
      
      // If we see messages from the same user as the current message
      if (msg.author.id === message.author.id) {
        consecutiveUserMessages++;
      }
      
      // If we detect a back-and-forth pattern (2+ users exchanging 3+ messages)
      if (userIds.size >= 2 && orderedMessages.length >= 3) {
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
  
  // Check if message is about clearly unrelated topics
  const hasUnrelatedTopics = UNRELATED_TOPICS.some(topic => {
    // Use word boundary check to avoid partial matches
    const regex = new RegExp(`\\b${topic}\\b`, 'i');
    return regex.test(normalizedContent);
  });

  // If message has unrelated topics and no Olas keywords, it's likely not Olas-related
  if (hasUnrelatedTopics && !hasOlasKeywords) {
    return false;
  }

  // If message has Olas keywords, it's likely Olas-related
  if (hasOlasKeywords) {
    return true;
  }

  // For messages without clear indicators, default to false
  return false;
}

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  // Check if this is part of a conversation between users
  if (await isConversationBetweenUsers(message)) {
    console.log("Skipping conversation between users");
    return;
  }

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

  // Only proceed if message is in a thread or in a text channel where we can create a thread
  if (!(message.channel instanceof ThreadChannel) && !(message.channel instanceof TextChannel)) {
    console.log("Skipping message - not in thread or thread-capable channel");
    return;
  }

  const messageContent = message.content.toLowerCase();

  // If asking about a previous message, get that message's content
  const previousMessage = await getPreviousMessage(message);
  const contentToCheck = previousMessage ? 
    previousMessage.content.toLowerCase() : 
    messageContent;

  // Skip blacklisted queries silently
  if (BLACKLIST_KEYWORDS.some(keyword => contentToCheck.includes(keyword))) {
    console.log("Skipping blacklisted query");
    return;
  }

  // Check if message is Olas-related
  const isOlasRelated = await isMessageOlasRelated(contentToCheck);
  
  // If message is not Olas-related and bot is not mentioned, skip
  if (!isOlasRelated && !isBotMentioned) {
    console.log("Skipping non-Olas related message");
    return;
  }

  // Check if this is a question we should answer
  const isTechnicalQuestion = TECHNICAL_KEYWORDS.some(keyword => contentToCheck.includes(keyword));
  const isSetupQuestion = SETUP_KEYWORDS.some(keyword => contentToCheck.includes(keyword));
  const isStakingQuestion = STAKING_KEYWORDS.some(keyword => contentToCheck.includes(keyword));

  // Should respond if:
  // 1. Bot is mentioned AND message is Olas-related OR
  // 2. Message is a question about Olas/agents OR
  // 3. Message is a technical/setup question about Olas OR
  // 4. Message is about staking mechanics (but not advice)
  const shouldRespond = (isBotMentioned && isOlasRelated) || 
                       (isOlasRelated && (contentToCheck.includes('?') || isSetupQuestion || isTechnicalQuestion)) ||
                       isStakingQuestion;

  if (shouldRespond) {
    // Add a random delay between 1-3 seconds before responding
    const delay = Math.floor(Math.random() * 2000) + 1000;
    await new Promise(resolve => setTimeout(resolve, delay));

    // If message is in a regular channel, create a thread first
    if (message.channel instanceof TextChannel) {
      // Clean up the message content for thread title
      const cleanTitle = message.content
        .replace(/<@!?\d+>/g, '') // Remove user mentions
        .replace(/<@&\d+>/g, '')  // Remove role mentions
        .replace(/<#\d+>/g, '')   // Remove channel mentions
        .replace(/\s*<@&?\d+>\s*/g, ' ') // Remove any remaining mention formats
        .replace(/\s*<[#@][!&]?\d+>\s*/g, ' ') // Remove any other Discord-style mentions
        .replace(/\s*\d{17,19}\s*/g, ' ') // Remove raw Discord IDs
        .trim()
        .slice(0, 50); // Limit length after cleaning

      const userMention = `@${message.author.username}`;
      const thread = await message.startThread({
        name: `${userMention} ${cleanTitle}`,
        autoArchiveDuration: 60,
      });

      // If it's a staking question, provide the standardized response in the thread
      if (isStakingQuestion && !isTechnicalQuestion) {
        const response = STAKING_RESPONSE + DISCLAIMER_NOTE;
        await thread.send(response);
        return;
      }

      // Process the message in the new thread
      if (previousMessage) {
        await processMessage(previousMessage);
      } else {
        await processMessage(message);
      }
      return;
    }

    // For messages already in threads
    if (message.channel instanceof ThreadChannel) {
      // If it's a staking question, provide the standardized response
      if (isStakingQuestion && !isTechnicalQuestion) {
        const response = STAKING_RESPONSE + DISCLAIMER_NOTE;
        await message.channel.send(response);
        return;
      }

      if (previousMessage) {
        await processMessage(previousMessage);
      } else {
        await processMessage(message);
      }
    }
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
  try {
    console.log("Starting to process message:", {
      content: message.content,
      author: message.author.username,
      channelId: message.channelId
    });

    const { limited, ttl } = await checkRateLimit(message.author.id, true);

    if (limited && useRateLimit) {
      await message.reply(
        `You've reached the message limit. Please try again in ${Math.ceil(
          ttl || 0
        )} seconds.`
      );
      return;
    }

    // Start typing indicator immediately
    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping();
    }

    const teamData = await getTeamData(TEAM_ID);
    console.log("Team data fetched successfully");

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
      console.log("Generating response for message:", message.content);
      
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
        console.error("Response generation failed with error:", {
          error: firstChunk.value.error,
          message: message.content,
          author: message.author.username
        });
        return;
      }

      console.log("Successfully generated first response chunk");

      let thread: ThreadChannel | undefined;
      
      // First try to get existing thread
      if (message.hasThread && message.thread) {
        thread = message.thread as ThreadChannel;
      } else if (message.channel instanceof TextChannel) {
        try {
          // Clean up the message content for thread title
          const cleanTitle = message.content
            .replace(/<@!?\d+>/g, '') // Remove user mentions
            .replace(/<@&\d+>/g, '')  // Remove role mentions
            .replace(/<#\d+>/g, '')   // Remove channel mentions
            .replace(/\s*<@&?\d+>\s*/g, ' ') // Remove any remaining mention formats
            .replace(/\s*<[#@][!&]?\d+>\s*/g, ' ') // Remove any other Discord-style mentions
            .replace(/\s*\d{17,19}\s*/g, ' ') // Remove raw Discord IDs
            .trim()
            .slice(0, 50); // Limit length after cleaning

          const userMention = `@${message.author.username}`;
          thread = await message.startThread({
            name: `${userMention} ${cleanTitle}`,
            autoArchiveDuration: 60,
          });
          console.log("Created new thread for response");
        } catch (error: any) {
          if (error.code === 'MessageExistingThread' && message.thread) {
            // If thread already exists, use it
            thread = message.thread as ThreadChannel;
            console.log("Using existing thread for response");
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

      // Use the thread or fall back to the original channel
      const targetChannel = thread || message.channel;
      await streamResponse(
        message,
        conversationHistory,
        teamData,
        thread,
        fullResponse
      );
      console.log("Successfully completed message processing");
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
