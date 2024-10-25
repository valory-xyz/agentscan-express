import { Router } from "express";

import { getCurrentSeason } from "../../helpers";
import supabase from "../../initalizers/supabaseClient";

const router = Router();

// Season management endpoints
router.post("/", async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        message: "Season name is required",
      });
    }

    // Start a transaction to handle setting current season
    const { data: season, error } = await supabase.rpc("create_new_season", {
      season_name: name,
    });

    if (error) throw error;

    return res.status(201).json(season);
  } catch (error) {
    console.error("Error creating season:", error);
    return res.status(500).json({
      message: "Failed to create season",
    });
  }
});

// Get current season
router.get("/", async (req, res) => {
  try {
    const currentSeason = await getCurrentSeason();
    if (!currentSeason) {
      return res.status(404).json({
        message: "No active season found",
      });
    }

    return res.json(currentSeason);
  } catch (error) {
    console.error("Error fetching current season:", error);
    return res.status(500).json({
      message: "Failed to fetch current season",
    });
  }
});

export default router;
