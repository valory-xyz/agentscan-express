export function cleanSummary(text: string) {
  const quotePattern = /\d+\.\)\s*"[^"]+"/g;
  // Remove the quotes and any list numbering from the summary
  let cleanedSummary = text.replace(quotePattern, "").trim();
  // Additional cleanup to remove any header or unwanted lines introduced by the quotes section
  cleanedSummary = cleanedSummary.replace(/Quotes:\s*/, "").trim();
  return cleanedSummary;
}

//PROFILE CREATION PROMPT (need to improve)
export const profile_creation_prompt = `
Assemble the individual summaries into a detailed character profile that captures the user's most prominent and whimsical aspects.
This narrative should paint a colorful and distinctive portrayal of the user, integrating all notable traits into a seamless story.
Aim for an engaging, light-hearted profile, limited to 300 words, that highlights a uniquely memorable post made by the user.
Also, from the data provided, generate and select ten quotes that the user might say during a match, reflecting their personality and type.
Ensure the quotes are relevant and enhance the character profile. The quotes should come in the format:
"Quotes:\n 1.) "Quote here!" 2.) "Quote here!" 3.) "Quote here!" ..., 10.) "Quote here!"`;

export function parseMoves(response: string) {
  // Improved regex to handle incomplete entries and ensure all sections are captured robustly
  const movePattern =
    /(\d+)\.\)\s*Subtype:\s*([^\n]+)\s*\nName:\s*([^\n]+)\s*\nDescription:\s*([\s\S]+?)(?=\n\d+\.\)|\n*$)/g;
  let match: any;
  let moves = [] as any;

  while ((match = movePattern.exec(response)) !== null) {
    const move = {
      subtype: match[2].trim(), // Capturing Subtype
      name: match[3].trim(), // Capturing Name
      description: match[4].trim().replace(/\n/g, " "), // Cleaning up Description
    } as any;
    moves.push(move);
  }

  // Adding a check to ensure moves are parsed correctly
  if (moves.length === 0) {
    return {
      valid: false,
      error: "No moves were detected.",
      moves: [], // Return an empty array if no moves are found
    };
  }

  return { valid: true, moves };
}
