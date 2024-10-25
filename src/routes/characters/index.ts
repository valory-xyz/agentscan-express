// src/routes/characters.ts or wherever your character endpoint is
import { Router } from "express";

import { CreateCharacterDto } from "../../types";
import supabase from "../../initalizers/supabaseClient";

const router = Router();

// Helper to check season status
async function checkSeasonStatus() {
  const { data: season, error } = await supabase
    .from("seasons")
    .select("*")
    .eq("is_current", true)
    .single();

  if (error) throw error;
  if (!season) throw new Error("No active season found");
  if (season.is_playing)
    throw new Error("Cannot create characters while the season is in play");

  return season;
}

// Create character endpoint
router.post("/", async (req, res) => {
  try {
    const { name, description, imageUrl }: CreateCharacterDto = req.body;
    console.log(req.body);

    if (!name || !imageUrl) {
      return res.status(400).json({
        message: "Name and image URL are required",
      });
    }

    // Check season status before creating character
    const currentSeason = await checkSeasonStatus();

    console.log(currentSeason);

    const { data: character, error } = await supabase
      .from("characters")
      .insert({
        name,
        description,
        image_url: imageUrl,
        status: "active",
        season_id: currentSeason.id,
      })
      .select()
      .single();

    if (error) {
      console.error("Error creating character:", error);
      return res.status(500).json({
        message: "Failed to create character",
        error: error.message,
      });
    }

    return res.status(201).json({
      character: {
        id: character.id,
        name: character.name,
        description: character.description,
        imageUrl: character.image_url,
        status: character.status,
        seasonId: character.season_id,
        createdAt: character.created_at,
        updatedAt: character.updated_at,
      },
      currentSeason,
    });
  } catch (error: any) {
    console.error("Error in character creation:", error);

    // Handle specific errors
    if (error.message === "No active season found") {
      return res.status(400).json({
        message: "No active season found",
      });
    }

    if (
      error.message === "Cannot create characters while the season is in play"
    ) {
      return res.status(403).json({
        message: "Cannot create characters while the season is in play",
      });
    }

    return res.status(500).json({
      message: "Internal server error",
    });
  }
});

export default router;
