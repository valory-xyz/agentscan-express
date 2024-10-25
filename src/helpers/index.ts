import supabase from "../initalizers/supabaseClient";
import { Season } from "../types";

// Helper function to get current season
export async function getCurrentSeason(): Promise<Season | null> {
  const { data: season, error } = await supabase
    .from("seasons")
    .select("*")
    .eq("is_current", true)
    .single();

  if (error) throw error;
  return season
    ? {
        id: season.id,
        name: season.name,
        isCurrent: season.is_current,
        createdAt: season.created_at,
        updatedAt: season.updated_at,
        isPlaying: season.is_playing,
      }
    : null;
}
