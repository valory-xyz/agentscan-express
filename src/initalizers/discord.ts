import { Client, Events, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import {
  handleMessage,
  handleSlashCommand,
  initializeMessageQueue,
  registerCommands,
} from "../services/discord";

dotenv.config();

if (!process.env.DISCORD_BOT_TOKEN) {
  throw new Error("DISCORD_BOT_TOKEN is required in environment variables");
}

export const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

discordClient.on("error", (error) => {
  console.error("Discord client error:", error);
});

export const initializeDiscord = async (): Promise<void> => {
  try {
    await discordClient.login(process.env.DISCORD_BOT_TOKEN);
    console.log(`Discord bot initialized as ${discordClient.user?.tag}`);

    initializeMessageQueue();

    discordClient.on(Events.ClientReady, async (readyClient) => {
      console.log(`Ready! Logged in as ${readyClient.user.tag}`);
      await registerCommands(discordClient);
    });

    discordClient.on(Events.MessageCreate, handleMessage);

    discordClient.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isCommand()) return;
      await handleSlashCommand(interaction);
    });

    discordClient.on(Events.ThreadCreate, async (thread) => {
      if (thread.joinable) await thread.join();
    });

    process.on("unhandledRejection", (error) => {
      console.error("Unhandled promise rejection:", error);
    });
  } catch (error) {
    console.error("Failed to initialize Discord bot:", error);
  }
};
