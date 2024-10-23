import express from "express";
import anthropic from "../../initalizers/anthropic";

const router = express.Router();

const CHARACTERS = [
  "Luna the shapeshifter",
  "Zephyr the wind mage",
  "Blaze the fire elemental",
  "Frost the ice archer",
  "Terra the earth bender",
  "Volt the lightning ninja",
  "Aqua the water manipulator",
  "Shadow the stealth assassin",
  "Flora the plant whisperer",
  "Nova the cosmic warrior",
] as const;

type CharacterName = (typeof CHARACTERS)[number];

interface CharacterState {
  characters: Map<CharacterName, boolean>;
  remainingCount: number;
}

const initialState: CharacterState = {
  characters: new Map(CHARACTERS.map((char) => [char, true])),
  remainingCount: CHARACTERS.length,
};

interface MessageQueue {
  type: "story" | "status";
  content?: string;
  characterStatus?: {
    remainingCharacters: CharacterName[];
    eliminatedCharacters: CharacterName[];
  };
}

router.get("/", async (req, res) => {
  const biome = (req.query.biome as string) || "tropical rainforest";

  // Initialize character state
  const characterState: CharacterState = {
    characters: new Map(CHARACTERS.map((char) => [char, true])),
    remainingCount: CHARACTERS.length,
  };

  const getCharacterStatus = () => {
    const remainingCharacters: CharacterName[] = [];
    const eliminatedCharacters: CharacterName[] = [];

    characterState.characters.forEach((isActive, character) => {
      if (isActive) {
        remainingCharacters.push(character);
      } else {
        eliminatedCharacters.push(character);
      }
    });

    return {
      remainingCharacters: remainingCharacters.sort(),
      eliminatedCharacters: eliminatedCharacters.sort(),
    };
  };

  const standardizeCharacterName = (name: string): CharacterName | null => {
    const standardized = CHARACTERS.find(
      (char) => char.toLowerCase() === name.toLowerCase().trim()
    );
    return standardized || null;
  };

  const sendMessage = (message: MessageQueue) => {
    res.write(`data: ${JSON.stringify(message)}\n\n`);
  };

  const processStatusUpdate = (statusContent: string) => {
    const activeMatch = statusContent.match(/ACTIVE:(.*?)(?=ELIMINATED:|$)/i);
    const eliminatedMatch = statusContent.match(/ELIMINATED:(.*?)$/i);

    const activeCharactersRaw = activeMatch
      ? activeMatch[1]
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
      : [];
    const eliminatedCharactersRaw = eliminatedMatch
      ? eliminatedMatch[1]
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
      : [];

    const activeCharacters = activeCharactersRaw
      .map(standardizeCharacterName)
      .filter((char): char is CharacterName => char !== null);
    const eliminatedCharacters = eliminatedCharactersRaw
      .map(standardizeCharacterName)
      .filter((char): char is CharacterName => char !== null);

    // Update character state
    CHARACTERS.forEach((character) => {
      const isCurrentlyActive = characterState.characters.get(character);
      const isListedEliminated = eliminatedCharacters.includes(character);

      if (isCurrentlyActive && isListedEliminated) {
        // Only change to eliminated if currently active and explicitly listed as eliminated
        characterState.characters.set(character, false);
      }
      // If not listed as eliminated, maintain current state (active or eliminated)
    });

    // Recalculate remaining count based on the updated character state
    characterState.remainingCount = Array.from(
      characterState.characters.values()
    ).filter(Boolean).length;

    return getCharacterStatus();
  };

  const generateStorySegment = async (previousContent: string = "") => {
    const storyPrompt = `
You are a master storyteller crafting an epic battle royale narrative set in a ${biome}. Continue the story with the following characters:
${CHARACTERS.map((char, index) => `${index + 1}. ${char}`).join("\n")}

Previous content:
${previousContent}

Instructions:
1. Write the next segment of the story in 4-6 detailed sentences, focusing on character development, interactions, and the challenges posed by the ${biome}.
2. Develop complex relationships and alliances between characters.
3. If appropriate, eliminate one character dramatically and meaningfully.
4. Incorporate twists, surprises, and moral dilemmas.
5. Continue the story, building towards an epic final confrontation.
6. After the segment, provide a status update using EXACT full character names.

Required format:
[STORY]
Write 4-6 sentences of detailed story here, rich with description and character development. Ensure proper paragraph formatting with lines between paragraphs for readability.
[/STORY]

[STATUS]
ACTIVE: List active characters here using their EXACT full names, comma-separated
ELIMINATED: List eliminated characters here using their EXACT full names, comma-separated
[/STATUS]

Remember to maintain a balance between action, dialogue, and introspection to create a truly engaging narrative.
`.trim();

    const baseDelay = 1000; // 1 second
    let attempt = 0;

    while (true) {
      try {
        const stream = await anthropic.messages.create({
          model: "claude-3-sonnet-20240229",
          max_tokens: 4096,
          messages: [{ role: "user", content: storyPrompt }],
          stream: true,
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

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    let previousContent = "";
    let isStoryComplete = false;

    while (!isStoryComplete) {
      const stream = await generateStorySegment(previousContent);

      let contentBuffer = "";
      let currentSection: "story" | "status" | null = null;
      let currentStoryContent = "";
      let currentStatusContent = "";

      for await (const chunk of stream) {
        if (
          chunk.type === "content_block_start" ||
          chunk.type === "content_block_delta"
        ) {
          const content =
            chunk.type === "content_block_delta" && "text" in chunk.delta
              ? chunk.delta.text
              : "";

          if (content) {
            contentBuffer += content;

            // Process story sections
            if (contentBuffer.includes("[STORY]")) {
              if (currentStoryContent) {
                // Send previous story segment
                sendMessage({
                  type: "story",
                  content: currentStoryContent.trim(),
                });
                currentStoryContent = "";
              }
              currentSection = "story";
              contentBuffer = contentBuffer.split("[STORY]").pop() || "";
            }

            if (
              currentSection === "story" &&
              contentBuffer.includes("[/STORY]")
            ) {
              const [storyContent] = contentBuffer.split("[/STORY]");
              currentStoryContent = storyContent.trim();
              contentBuffer = contentBuffer.split("[/STORY]").pop() || "";
              currentSection = null;

              // Send story content immediately
              sendMessage({
                type: "story",
                content: currentStoryContent,
              });
            }

            // Process status sections
            if (contentBuffer.includes("[STATUS]")) {
              currentSection = "status";
              contentBuffer = contentBuffer.split("[STATUS]").pop() || "";
            }

            if (
              currentSection === "status" &&
              contentBuffer.includes("[/STATUS]")
            ) {
              const [statusContent] = contentBuffer.split("[/STATUS]");
              currentStatusContent = statusContent.trim();
              contentBuffer = contentBuffer.split("[/STATUS]").pop() || "";

              // Process and send status update
              const updatedStatus = processStatusUpdate(currentStatusContent);
              sendMessage({
                type: "status",
                characterStatus: updatedStatus,
              });

              currentSection = null;
            }
          }
        }
      }

      // After processing the status update
      if (currentStatusContent) {
        const updatedStatus = processStatusUpdate(currentStatusContent);
        sendMessage({
          type: "status",
          characterStatus: updatedStatus,
        });

        if (characterState.remainingCount <= 1) {
          isStoryComplete = true;
        }

        currentStatusContent = "";
      }

      previousContent +=
        currentStoryContent + "\n\n" + currentStatusContent + "\n\n";
    }

    // Generate epilogue
    const epiloguePrompt = `
      Write a brief epilogue for the victor of the battle royale in the ${biome}. Reflect on their journey, the challenges they overcame, and how the experience has changed them. Limit the epilogue to 3-4 sentences.

      [STORY]
      Write the epilogue here.
      [/STORY]
    `;

    const epilogueStream = await anthropic.messages.create({
      model: "claude-3-5-sonnet-latest",
      max_tokens: 4096,
      messages: [{ role: "user", content: epiloguePrompt }],
      stream: true,
    });

    let epilogueContent = "";

    for await (const chunk of epilogueStream) {
      if (
        chunk.type === "content_block_start" ||
        chunk.type === "content_block_delta"
      ) {
        const content =
          chunk.type === "content_block_delta" && "text" in chunk.delta
            ? chunk.delta.text
            : "";

        if (content) {
          epilogueContent += content;

          if (epilogueContent.includes("[STORY]")) {
            epilogueContent = epilogueContent.split("[STORY]").pop() || "";
          }

          if (epilogueContent.includes("[/STORY]")) {
            const [storyContent] = epilogueContent.split("[/STORY]");
            epilogueContent = storyContent.trim();

            sendMessage({
              type: "story",
              content: epilogueContent,
            });

            break;
          }
        }
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error: any) {
    console.error("Error generating story:", error);
    res.status(error.status || 500).json({
      error: error.message || "An error occurred while generating the story",
    });
  }
});

export default router;
