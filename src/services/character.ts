import openai from "../config/openai";
import { parseMoves } from "../helpers";

export const generate_moves = async (
  summary: string,
  type: string,
  name: string
) => {
  const type_descriptions: any = {
    oracle:
      "The Oracle, a visionary scientist, manipulates timelines and probabilities. Subtypes: Temporal, Psychic, Quantum.",
    sentinel:
      "The Sentinel, a master of stealth and protection. Subtypes: Stealth, Armored, Tactical.",
    artist:
      "The Artist, a creator of visual and auditory illusions. Subtypes: Illusion, Abstract, Performative.",
    builder:
      "The Builder, an architect of fortifications. Subtypes: Engineering, Structural, Mechanic.",
  };

  const description = type_descriptions[type] || "Unknown type";
  if (description === "Unknown type") {
    console.error("Invalid character type provided.");
    return null;
  }

  // Example response to include in the prompt
  const exampleResponse = `Character Moves for Jasper, the Oracle:\n\n1.)\nSubtype: Temporal\n\nName:\n Future Flicker\n\nDescription: Jasper snaps his fingers, causing his opponent to briefly experience fast-forwarded versions of themselves. This move disorients them with glimpses of future mishaps.\n2.) Subtype: Quantum\n\nName: Chrono Crackle\n\nDescription: Jasper tosses a sparkling orb into the air, which bursts into shimmering dust that randomly accelerates or decelerates time around the opponent. Their movements become comically out of sync.\n3.) Subtype: Psychic\n\nName: Paradox Poke\n\nDescription: Jasper points at an opponent, initiating a paradox where the opponent briefly encounters their past self. The two selves argue comically, leading to a fight.`;

  const moves_creation_prompt = `
      Using the detailed character summary and the type description, design three humorous and unique moves for ${name}, the ${type}.
      Each move should have a compelling name, describe its amusing effects, and illustrate how it embodies the character's traits and subtype.
      Envision each description as a quirky move from a comedic fighting game. The description should be 75 words or less. Take your time.
  
      Example Response:
      ${exampleResponse}
    `;

  const detailed_prompt = `Character Name: ${name}\n\nType: ${type} - ${description}\n\nCharacter Summary: ${summary}\n\n`;

  let response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    temperature: 0.2,
    messages: [
      { role: "system", content: moves_creation_prompt },
      { role: "user", content: detailed_prompt },
    ],
  });

  let moves = parseMoves(response.choices[0].message.content as string);
  let retries = 0;
  while (!moves.valid && retries < 4) {
    await new Promise((r) => setTimeout(r, 5000));
    response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      temperature: 0.2,
      messages: [
        { role: "system", content: moves_creation_prompt },
        { role: "user", content: detailed_prompt },
      ],
    });
    moves = parseMoves(response.choices[0].message.content as string);
    retries++;
  }

  return moves;
};
