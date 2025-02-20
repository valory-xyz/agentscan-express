import { db } from "../initalizers/postgres";
import {
  teams,
  users,
  discord_servers,
  discord_allowed_channels,
  chat_sessions,
  chat_messages,
  context_embeddings,
  context_labels,
  contract_abis,
  context_processing_status,
} from "./migrations/schema";

// Safety check function to ensure we're in local development
function ensureLocalDevelopment() {
  if (process.env.USE_LOCAL_DB !== "true") {
    throw new Error(
      "Safety Error: Seeding operations require USE_LOCAL_DB=true environment variable. " +
        "This helps prevent accidental modifications to production databases."
    );
  }
}

// Function to get current data from all tables
export async function exportCurrentData() {
  try {
    const currentData = {
      teams: await db.select().from(teams),
      users: await db.select().from(users),
      discordServers: await db.select().from(discord_servers),
      discordAllowedChannels: await db.select().from(discord_allowed_channels),
      chatSessions: await db.select().from(chat_sessions),
      chatMessages: await db.select().from(chat_messages),
      contextEmbeddings: await db.select().from(context_embeddings),
      contextLabels: await db.select().from(context_labels),
      contractAbis: await db.select().from(contract_abis),
      contextProcessingStatus: await db
        .select()
        .from(context_processing_status),
    };

    // Write the data to a JSON file
    const fs = require("fs");
    const path = require("path");
    const seedPath = path.join(__dirname, "seed-data.json");

    fs.writeFileSync(seedPath, JSON.stringify(currentData, null, 2));
    console.log(`Seed data exported to ${seedPath}`);

    return currentData;
  } catch (error) {
    console.error("Error exporting data:", error);
    throw error;
  }
}

// Function to seed the database with the exported data
export async function seedDatabase() {
  try {
    ensureLocalDevelopment();

    const fs = require("fs");
    const path = require("path");
    const seedPath = path.join(__dirname, "seed-data.json");

    if (!fs.existsSync(seedPath)) {
      throw new Error(
        "Seed data file not found. Please run exportCurrentData() first."
      );
    }

    const seedData = JSON.parse(fs.readFileSync(seedPath, "utf-8"));

    // Begin transaction
    await db.transaction(async (tx) => {
      // Clear existing data (optional - comment out if you want to keep existing data)
      await tx.delete(context_labels);
      await tx.delete(context_embeddings);
      await tx.delete(chat_messages);
      await tx.delete(chat_sessions);
      await tx.delete(discord_allowed_channels);
      await tx.delete(discord_servers);
      await tx.delete(contract_abis);
      await tx.delete(context_processing_status);
      await tx.delete(users);
      await tx.delete(teams);

      // Insert seed data in correct order (respecting foreign key constraints)
      if (seedData.teams?.length) await tx.insert(teams).values(seedData.teams);
      if (seedData.users?.length) await tx.insert(users).values(seedData.users);
      if (seedData.discordServers?.length)
        await tx.insert(discord_servers).values(seedData.discordServers);
      if (seedData.discordAllowedChannels?.length)
        await tx
          .insert(discord_allowed_channels)
          .values(seedData.discordAllowedChannels);
      if (seedData.chatSessions?.length)
        await tx.insert(chat_sessions).values(seedData.chatSessions);
      if (seedData.chatMessages?.length)
        await tx.insert(chat_messages).values(seedData.chatMessages);
      if (seedData.contextEmbeddings?.length)
        await tx.insert(context_embeddings).values(seedData.contextEmbeddings);
      if (seedData.contextLabels?.length)
        await tx.insert(context_labels).values(seedData.contextLabels);
      if (seedData.contractAbis?.length)
        await tx.insert(contract_abis).values(seedData.contractAbis);
      if (seedData.contextProcessingStatus?.length)
        await tx
          .insert(context_processing_status)
          .values(seedData.contextProcessingStatus);
    });

    console.log("Database seeded successfully!");
  } catch (error) {
    console.error("Error seeding database:", error);
    throw error;
  }
}

// CLI handler
if (require.main === module) {
  const command = process.argv[2];

  if (command === "export") {
    exportCurrentData()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  } else if (command === "seed") {
    seedDatabase()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  } else {
    console.log("Please specify a command: export or seed");
    process.exit(1);
  }
}
