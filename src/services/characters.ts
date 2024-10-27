import { query } from "../initializers/postgres";

export function normalizeCharacters(characters: any[]) {
  return characters.map((char) => ({
    id: char.id,
    name: char.name,
    description: char.description,
    imageUrl: char.image_url,
    status: char.status,
    seasonId: char.season_id,
    createdAt: char.created_at,
    updatedAt: char.updated_at,
  }));
}

export const updateCharacterStatus = async (
  characterId: string,
  status: "active" | "eliminated"
) => {
  await query("UPDATE public.characters SET status = $1 WHERE id = $2", [
    status,
    characterId,
  ]);
};

export const getCurrentSeasonAndCharacters = async () => {
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
};
