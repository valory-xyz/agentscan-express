import openai from "../initalizers/openai";
import supabase from "../initalizers/supabaseClient";

// Get current season and its characters
export async function getCurrentSeasonAndCharacters() {
  const { data: season, error: seasonError } = await supabase
    .from("seasons")
    .select("*")
    .eq("is_current", true)
    .single();

  if (seasonError || !season) {
    throw new Error("No active season found");
  }

  const { data: characters, error: charactersError } = await supabase
    .from("characters")
    .select("*")
    .eq("season_id", season.id)
    .eq("status", "active");

  if (charactersError) {
    throw new Error("Failed to fetch characters");
  }

  if (!characters || characters.length === 0) {
    throw new Error("No active characters found for current season");
  }

  return { season, characters };
}

// Set season to playing
export async function setSeasonPlaying(seasonId: string, isPlaying: boolean) {
  const { error } = await supabase
    .from("seasons")
    .update({ is_playing: isPlaying })
    .eq("id", seasonId);

  if (error) throw error;
}

// Create new season
export async function createNewSeason(previousSeasonId: string) {
  const { data: previousSeason } = await supabase
    .from("seasons")
    .select("name")
    .eq("id", previousSeasonId)
    .single();

  // Extract number from previous season name or default to 0
  const previousNumber = parseInt(previousSeason?.name?.split(" ")[1] || "0");
  const newSeasonNumber = previousNumber + 1;

  const { data: newSeason, error } = await supabase.rpc("create_new_season", {
    season_name: `Season ${newSeasonNumber}`,
  });

  if (error) throw error;
  return newSeason;
}

// Update character status
export async function updateCharacterStatus(
  characterId: string,
  status: "active" | "eliminated"
) {
  const { error } = await supabase
    .from("characters")
    .update({ status })
    .eq("id", characterId);

  if (error) throw error;
}

export const generateStorySegment = async (
  characters: any,
  biome: any,
  previousContent: string = ""
) => {
  const characterList = characters
    .map(
      (char: any, index: number) =>
        `${index + 1}. name: ${char.name}, description: ${
          char.description || "No description"
        }`
    )
    .join("\n");
  const storyPrompt = `
You are a master storyteller crafting a battle royale narrative set in a ${biome}. Your task is to continue the story with the following characters:
${characterList}

Previous content:
${previousContent}

You must follow these format rules exactly:
1. Begin with exactly "[STORY]" on its own line
2. Write 3-5 sentences of detailed story content
3. End the story section with exactly "[/STORY]" on its own line
4. Skip one line
5. Begin the status section with exactly "[STATUS]" on its own line
6. List active characters with exactly "ACTIVE:" followed by comma-separated full character names
7. On the next line, list eliminated characters with exactly "ELIMINATED:" followed by comma-separated full character names
8. End with exactly "[/STATUS]" on its own line

Story writing instructions:
1. Focus on character development, interactions, and the challenges posed by the ${biome}
2. Develop complex relationships and alliances between characters
3. Eliminate at least one character dramatically and meaningfully in each segment
4. Incorporate twists, surprises, and moral dilemmas
5. Build towards an epic final confrontation

Remember to maintain perfect formatting and eliminate at least one character in each segment.
`.trim();

  const baseDelay = 1000; // 1 second
  let attempt = 0;

  while (true) {
    try {
      const stream = await openai.chat.completions.create({
        model: "gpt-4o-mini", // Or another appropriate OpenAI model
        messages: [{ role: "user", content: storyPrompt }],
        stream: true,
        max_tokens: 1000,
      });

      return stream;
    } catch (error: any) {
      if (error.status === 429) {
        attempt++;
        const delay = baseDelay * Math.pow(2, Math.min(attempt, 10)); // Cap at ~17 minutes max delay
        console.log(
          `Rate limit exceeded. Retrying in ${delay}ms... (Attempt ${attempt})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        console.error("Error generating story segment:", error);
        throw error;
      }
    }
  }
};

export const standardizeCharacterName = (
  name: string,
  characters: any[]
): string | null => {
  const standardized = characters.find(
    (char) => char.name.toLowerCase() === name.toLowerCase().trim()
  );
  return standardized || null;
};
