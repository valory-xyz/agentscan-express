import express from "express";
import openai from "../../initalizers/openai";
import {
  getCurrentSeasonAndCharacters,
  standardizeCharacterName,
} from "../../services/story";

const router = express.Router();

interface CharacterState {
  characters: Map<string, boolean>;
  remainingCount: number;
}

interface MessageQueue {
  type: "story" | "status";
  content?: string;
  characterStatus?: {
    remainingCharacters: string[];
    eliminatedCharacters: string[];
  };
}

router.get("/", async (req, res) => {
  const biome = (req.query.biome as string) || "tropical rainforest";

  const { characters } = await getCurrentSeasonAndCharacters();
  // Initialize character state
  const characterState: CharacterState = {
    characters: new Map(characters.map((char) => [char.name, true])),
    remainingCount: characters.length,
  };

  const getCharacterStatus = () => {
    const remainingCharacters: string[] = [];
    const eliminatedCharacters: string[] = [];

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
      .map((char) => standardizeCharacterName(char, characters))
      .filter((char): char is string => char !== null);
    const eliminatedCharacters = eliminatedCharactersRaw
      .map((char) => standardizeCharacterName(char, characters))
      .filter((char): char is string => char !== null);

    // Update character state
    characters.forEach((character) => {
      const isCurrentlyActive = characterState.characters.get(character.name);
      const isListedEliminated = eliminatedCharacters.includes(character.name);

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

  const generateStorySegment = async (
    characters: any[],
    previousContent: string = ""
  ) => {
    const strings = characters.map(
      (char) => `name: ${char.name} description: (${char.description})`
    );
    const storyPrompt = `
You are a master storyteller crafting an epic battle royale narrative set in a ${biome}. Continue the story with the following characters:
${strings.map((char, index) => `${index + 1}. ${char}`).join("\n")}

Previous content:
${previousContent}

Instructions:
1. Write the next segment of the story in 1-3 detailed sentences, focusing on character development, interactions, and the challenges posed by the ${biome}.
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

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    let previousContent = "";
    let isStoryComplete = false;

    while (!isStoryComplete) {
      const stream = await generateStorySegment(characters, previousContent);

      let contentBuffer = "";
      let currentSection: "story" | "status" | null = null;
      let currentStoryContent = "";
      let currentStatusContent = "";

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
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

    const epilogueStream = await openai.chat.completions.create({
      model: "gpt-4", // Or another appropriate OpenAI model
      messages: [{ role: "user", content: epiloguePrompt }],
      stream: true,
      max_tokens: 300, // Adjust as needed
    });

    let epilogueContent = "";

    for await (const chunk of epilogueStream) {
      const content = chunk.choices[0]?.delta?.content || "";
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
