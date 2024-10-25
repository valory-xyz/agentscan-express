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
