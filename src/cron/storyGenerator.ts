import cron from "node-cron";
import { query } from "../initializers/postgres";

import { config } from "../config";
import { standardizeCharacterName } from "../services/story";
import openai from "../initalizers/openai";
import {
  generateAndUploadImage,
  generateAndUploadGIF,
  generateImagePrompt,
} from "../services/image";

interface MessageQueue {
  type: "story" | "status";
  content?: string;
  characterStatus?: {
    remainingCharacters: string[];
    eliminatedCharacters: string[];
  };
}

const BIOMES = [
  "desert",
  "tundra",
  "rainforest",
  "mountains",
  "swamp",
  "grassland",
  "volcanic",
  "coastal",
  "jungle",
  "arctic",
];

async function startNewSeason(currentSeasonNumber: number): Promise<void> {
  const randomBiome = BIOMES[Math.floor(Math.random() * BIOMES.length)];
  const nextSeasonNumber = currentSeasonNumber + 1;
  const seasonName = `Season ${nextSeasonNumber}`;

  await query(
    "UPDATE public.seasons SET is_playing = false, is_current = false WHERE is_playing = true"
  );

  await query(
    "INSERT INTO public.seasons (name, season_number, is_current, biome, is_playing) VALUES ($1, $2, true, $3, false)",
    [seasonName, nextSeasonNumber, randomBiome]
  );
}

async function getCurrentSeasonAndCharacters() {
  const seasonResult = await query(
    "SELECT * FROM public.seasons ORDER BY created_at DESC LIMIT 1"
  );
  const season = seasonResult.rows[0];

  const charactersResult = await query(
    "SELECT * FROM public.characters WHERE season_id = $1",
    [season.id]
  );
  const characters = charactersResult.rows;

  return { season, characters };
}

async function getCurrentStory(seasonId: string) {
  const result = await query(
    "SELECT * FROM public.stories WHERE season_id = $1 ORDER BY page DESC LIMIT 1",
    [seasonId]
  );
  return result.rows[0] || null;
}

// Update the story segment generation to include image generation
async function addStorySegment(
  seasonId: string,
  content: string,
  biome: string,
  generatedImagePrompt: string | undefined = undefined,
  retryAttempt: number = 0
) {
  const latestStoryResult = await query(
    "SELECT page FROM public.stories WHERE season_id = $1 ORDER BY page DESC LIMIT 1",
    [seasonId]
  );

  const latestStory = latestStoryResult.rows[0];
  const newPage = latestStory ? latestStory.page + 1 : 1;

  let generatedImageUrl: string | undefined = "";
  let generatedVideoUrl: string | undefined = "";
  let imagePrompt: string | undefined = generatedImagePrompt;
  if (!imagePrompt) {
    imagePrompt = await generateImagePrompt(content, biome);
  }
  // Generate image prompt and image
  imagePrompt = await generateImagePrompt(imagePrompt, biome);
  //try generating a video url
  generatedImageUrl = await generateAndUploadGIF(imagePrompt);
  //if that fails, generate an image
  if (!generatedImageUrl) {
    generatedImageUrl = await generateAndUploadImage(imagePrompt);
  }

  //if both fail, don't save the story and retry
  if (!generatedImageUrl) {
    retryAttempt++;
    if (retryAttempt > 5) {
      console.error("Failed to generate image and video after 5 retries");
      return;
    }
    await addStorySegment(seasonId, content, biome, imagePrompt, retryAttempt);
  }

  await query(
    "INSERT INTO public.stories (content, image_url, video_url, season_id, page) VALUES ($1, $2, $3, $4, $5)",
    [content, generatedImageUrl, generatedVideoUrl, seasonId, newPage]
  );
}

async function getCharacterStatus() {
  const result = await query(
    "SELECT * FROM public.characters WHERE season_id = (SELECT id FROM public.seasons ORDER BY created_at DESC LIMIT 1)"
  );
  const characters = result.rows;

  const remainingCharacters = characters
    .filter((char) => char.status === "active")
    .map((char) => char.name)
    .sort();
  const eliminatedCharacters = characters
    .filter((char) => char.status === "eliminated")
    .map((char) => char.name)
    .sort();

  return { remainingCharacters, eliminatedCharacters };
}

async function processStatusUpdate(
  statusContent: string,
  seasonId: string
): Promise<{ remainingCharacters: string[]; eliminatedCharacters: string[] }> {
  const activeMatch = statusContent.match(/ACTIVE:(.*?)(?=ELIMINATED:|$)/i);
  const eliminatedMatch = statusContent.match(/ELIMINATED:(.*?)$/i);

  // Fetch all characters for the current season
  const allCharactersResult = await query(
    "SELECT name FROM public.characters WHERE season_id = $1",
    [seasonId]
  );
  const existingCharacters = new Set(
    allCharactersResult.rows.map((char) => char.name.toLowerCase())
  );

  const activeCharactersRaw = activeMatch
    ? activeMatch[1]
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .filter((name) => existingCharacters.has(name.toLowerCase()))
    : [];
  const eliminatedCharactersRaw = eliminatedMatch
    ? eliminatedMatch[1]
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .filter((name) => existingCharacters.has(name.toLowerCase()))
    : [];

  // Update character statuses in the database
  for (const characterName of activeCharactersRaw) {
    await query(
      "UPDATE public.characters SET status = 'active' WHERE LOWER(name) = LOWER($1) AND season_id = $2",
      [characterName, seasonId]
    );
  }

  for (const characterName of eliminatedCharactersRaw) {
    await query(
      "UPDATE public.characters SET status = 'eliminated' WHERE LOWER(name) = LOWER($1) AND season_id = $2",
      [characterName, seasonId]
    );
  }

  // Fetch updated character statuses
  const updatedCharacters = await query(
    "SELECT name, status FROM public.characters WHERE season_id = $1",
    [seasonId]
  );

  const remainingCharacters = updatedCharacters.rows
    .filter((char) => char.status === "active")
    .map((char) => char.name)
    .sort();
  const eliminatedCharacters = updatedCharacters.rows
    .filter((char) => char.status === "eliminated")
    .map((char) => char.name)
    .sort();

  return { remainingCharacters, eliminatedCharacters };
}

async function generateStorySegment(
  characters: any[],
  previousContent: string = "",
  biome: string
) {
  const strings = characters.map(
    (char) => `name: ${char.name} description: (${char.description})`
  );
  const storyPrompt = `
You are a master storyteller crafting an epic battle royale narrative set in a ${biome}. Continue the story with the following characters:
${strings.map((char, index) => `${index + 1}. ${char}`).join("\n")}

Previous content:
${previousContent}

Instructions:
1. Write the next segment of the story in ONE SHORT sentence (maximum 45 words), focusing on a single key moment or interaction.
2. Develop complex relationships and alliances between characters.
3. Eliminate at least one character dramatically and meaningfully every 3-5 story segments.
4. After each segment, provide a status update using EXACT full character names.
5. Do not include any other characters in the status update other than the ones that are active or eliminated.
6. There must never be no active characters left in the status update.

Required format:
[STORY]
Write ONE SHORT sentence here (max 30 words).
[/STORY]

[STATUS]
ACTIVE: List active characters here using their EXACT full names, comma-separated
ELIMINATED: List eliminated characters here using their EXACT full names, comma-separated
[/STATUS]
`.trim();

  const stream = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: storyPrompt }],
    stream: true,
    max_tokens: 500,
  });

  return stream;
}

async function generateStory() {
  const { season, characters } = await getCurrentSeasonAndCharacters();
  let currentCharacters = characters;
  if (characters.length === 0) {
    return;
  }
  await query(`
    UPDATE seasons 
    SET is_playing = true 
    WHERE is_current = true
  `);

  const currentStory = await getCurrentStory(season.id);
  const biome = season.biome;

  let previousContent = currentStory ? currentStory.content : "";
  let isStoryComplete = false;

  try {
    while (!isStoryComplete) {
      const stream = await generateStorySegment(
        currentCharacters,
        previousContent,
        biome
      );

      let contentBuffer = "";
      let currentStoryContent = "";
      let currentStatusContent = "";

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        contentBuffer += content;
      }

      // Extract story content
      const storyMatch = contentBuffer.match(/\[STORY\]([\s\S]*?)\[\/STORY\]/);
      if (storyMatch) {
        currentStoryContent = storyMatch[1].trim();
      } else {
        console.error("Story content not found in the expected format");
        continue;
      }

      // Extract status content
      const statusMatch = contentBuffer.match(
        /\[STATUS\]([\s\S]*?)\[\/STATUS\]/
      );
      if (statusMatch) {
        currentStatusContent = statusMatch[1].trim();
      } else {
        console.error("Status content not found in the expected format");
        continue;
      }

      // Process story content
      if (currentStoryContent) {
        await addStorySegment(season.id, currentStoryContent, biome);
      }

      // Process status content
      if (currentStatusContent) {
        const updatedStatus = await processStatusUpdate(
          currentStatusContent,
          season.id
        );

        // Update the currentCharacters array with the new status
        currentCharacters = await query(
          "SELECT * FROM public.characters WHERE season_id = $1",
          [season.id]
        ).then((result) => result.rows);
      }

      // Check if story is complete
      const { remainingCharacters } = await getCharacterStatus();
      if (remainingCharacters.length <= 1) {
        isStoryComplete = true;

        // If we have a winner, update the winner_id
        if (remainingCharacters.length === 1) {
          const winnerName = remainingCharacters[0];
          await query(
            `
            WITH winner_id AS (
              SELECT id FROM characters 
              WHERE LOWER(name) = LOWER($1) AND season_id = $2
              LIMIT 1
            )
            UPDATE seasons 
            SET winner_id = (SELECT id FROM winner_id)
            WHERE id = $2
          `,
            [winnerName, season.id]
          );
        }
      }

      // Add 10 second delay before next iteration
      await new Promise((resolve) => setTimeout(resolve, 10000));

      previousContent +=
        currentStoryContent + "\n\n" + currentStatusContent + "\n\n";
    }

    // Update the season completion logic to use season_number
    await startNewSeason(season.season_number);
  } catch (error) {
    console.error("Error in story generation:", error);
    // Ensure is_playing is set to false if there's an error
    await query(
      `
      UPDATE seasons 
      SET is_playing = false 
      WHERE id = $1
    `,
      [season.id]
    );
    throw error;
  }
}

// Schedule the cron job to run every hour
cron.schedule("0 * * * *", async () => {
  console.log("Running story generation cron job");
  try {
    await generateStory();
  } catch (error) {
    console.error("Error in story generation cron job:", error);
  }
});

export const startStoryGeneratorCron = () => {
  console.log("Story generator cron job scheduled");
  generateStory();
};
