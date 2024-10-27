// server-side socket initialization
import { createAdapter } from "@socket.io/redis-streams-adapter";
import { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { redis } from "./redis";

import { normalizeCharacters } from "../services/characters";
import supabase from "./supabaseClient";

interface SocketSubscription {
  channel?: any;
  seasonChannel?: any;
  storyChannel?: any;
}

const subscriptions = new Map<string, SocketSubscription>();

let io: SocketIOServer;

async function setupCharacterSubscription(socket: any) {
  try {
    // Updated current season fetch to use season_number
    const { data: currentSeason, error: seasonError } = await supabase
      .from("seasons")
      .select("id, season_number, name, biome")
      .eq("is_current", true)
      .single();

    if (seasonError) throw seasonError;
    const currentSeasonId = currentSeason?.id;

    // Add season number to socket emit events for proper channel identification
    socket.emit("season_info", {
      seasonId: currentSeasonId,
      seasonNumber: currentSeason?.season_number,
      name: currentSeason?.name,
      biome: currentSeason?.biome,
    });

    // Initial character fetch
    const query = supabase
      .from("characters")
      .select("*")
      .order("created_at", { ascending: false })
      .eq("season_id", currentSeasonId);

    const { data: characters, error } = await query;
    if (error) throw error;
    const normalizedCharacters = normalizeCharacters(characters);

    // Send initial data
    socket.emit("characters_reset");
    socket.emit("initial_characters", normalizedCharacters);

    // Fetch current winner if exists
    const { data: winner, error: winnerError } = await supabase
      .from("seasons")
      .select("winner_id")
      .eq("id", currentSeasonId)
      .single();

    if (!winnerError && winner?.winner_id) {
      socket.emit("winner_declared", { winnerId: winner.winner_id });
    }

    const subscription = subscriptions.get(socket.id);
    if (subscription) {
      // Clean up existing subscription if any
      if (subscription.channel) {
        supabase.removeChannel(subscription.channel);
      }

      // Create new subscription for characters
      const channel = supabase
        .channel(`characters-s${currentSeason.season_number}-${socket.id}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "characters",
            filter: `season_id=eq.${currentSeasonId}`,
          },
          (payload: any) => {
            const normalizedCharacter = normalizeCharacters([
              payload.new || payload.old,
            ]);
            const newCharacter = normalizedCharacter[0];

            socket.emit("character_update", {
              type: payload.eventType,
              data: newCharacter,
            });
          }
        )
        .subscribe();

      // Create subscription for stories
      const storyChannel = supabase
        .channel(`stories-s${currentSeason.season_number}-${socket.id}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "stories",
            filter: `season_id=eq.${currentSeasonId}`,
          },
          (payload: any) => {
            socket.emit("story_update", {
              type: payload.eventType,
              data: payload.new || payload.old,
            });
          }
        )
        .subscribe();

      // Update season channel to include season status changes
      const seasonChannel = supabase
        .channel(`seasons-${socket.id}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "seasons",
          },
          async (payload: any) => {
            // If a new season becomes current
            if (payload.new?.is_current && !payload.old?.is_current) {
              socket.emit("new_season", {
                seasonId: payload.new.id,
                seasonNumber: payload.new.season_number,
                name: payload.new.name,
                biome: payload.new.biome,
              });

              // Fetch and emit characters for the new season
              const { data: newSeasonCharacters, error } = await supabase
                .from("characters")
                .select("*")
                .eq("season_id", payload.new.id)
                .order("created_at", { ascending: false });

              if (!error && newSeasonCharacters) {
                const normalizedNewCharacters =
                  normalizeCharacters(newSeasonCharacters);
                socket.emit("characters_reset");
                socket.emit("initial_characters", normalizedNewCharacters);
              }
            }

            // Emit season status updates
            if (payload.new?.is_playing !== payload.old?.is_playing) {
              socket.emit("season_status_change", {
                status: payload.new.status,
                seasonId: payload.new.id,
              });
            }

            // Handle winner updates
            if (payload.new?.winner_id !== payload.old?.winner_id) {
              socket.emit("winner_declared", {
                winnerId: payload.new.winner_id,
              });
            }
          }
        )
        .subscribe();

      // Update subscription tracking
      subscriptions.set(socket.id, {
        ...subscription,
        channel,
        seasonChannel,
        storyChannel,
      });
    }
  } catch (error) {
    console.error("Error setting up subscriptions:", error);
    socket.emit("error", "Failed to fetch data");
  }
}

async function setupStorySubscription(socket: any) {
  try {
    // Fetch current season
    const { data: currentSeason, error: seasonError } = await supabase
      .from("seasons")
      .select("id")
      .eq("is_current", true)
      .single();

    if (seasonError) throw seasonError;
    const currentSeasonId = currentSeason?.id;

    // Initial stories fetch
    const { data: stories, error } = await supabase
      .from("stories")
      .select("*")
      .order("created_at", { ascending: true })
      .eq("season_id", currentSeasonId);
    if (error) throw error;

    // Send initial data
    socket.emit("stories_reset");
    socket.emit("initial_stories", stories);
  } catch (error) {
    console.error("Error setting up story subscription:", error);
    socket.emit("error", "Failed to fetch stories");
  }
}

async function fetchSeasonData(seasonId: string, socket: any) {
  try {
    // Include additional season fields in the fetch
    const { data: season, error: seasonError } = await supabase
      .from("seasons")
      .select("*")
      .eq("id", seasonId)
      .single();
    if (seasonError) throw seasonError;

    // Emit expanded season info
    socket.emit("season_info", {
      seasonId: season.id,
      seasonNumber: season.season_number,
      name: season.name,
      biome: season.biome,
      isPlaying: season.is_playing,
    });

    // Fetch characters for the specific season
    const { data: characters, error: charactersError } = await supabase
      .from("characters")
      .select("*")
      .eq("season_id", seasonId)
      .order("created_at", { ascending: false });

    if (charactersError) throw charactersError;

    // Fetch stories for the specific season
    const { data: stories, error: storiesError } = await supabase
      .from("stories")
      .select("*")
      .eq("season_id", seasonId)
      .order("created_at", { ascending: true });

    if (storiesError) throw storiesError;

    // Emit all data
    socket.emit("characters_reset");
    socket.emit("stories_reset");
    socket.emit("initial_characters", normalizeCharacters(characters));
    socket.emit("initial_stories", stories);

    if (season.winner_id) {
      socket.emit("winner_declared", { winnerId: season.winner_id });
    }

    socket.emit("season_status_change", {
      status: season.is_playing,
      seasonId: season.id,
    });
  } catch (error) {
    console.error("Error fetching season data:", error);
    socket.emit("error", "Failed to fetch season data");
  }
}

function initializeSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      methods: ["GET", "POST"],
      credentials: true,
    },
    adapter: createAdapter(redis),
  });

  io.on("connection", async (socket) => {
    console.log(`User connected: ${socket.id}`);
    subscriptions.set(socket.id, {});

    // Simplified to not take seasonId
    socket.on("request_characters", async () => {
      await setupCharacterSubscription(socket);
    });

    // Add new story request handler
    socket.on("request_stories", async () => {
      await setupStorySubscription(socket);
    });

    // Add new handler for fetching specific season data
    socket.on("fetch_season", async (seasonId: string) => {
      await fetchSeasonData(seasonId, socket);
    });

    // Add new seasons request handler
    socket.on("request_seasons", async () => {
      try {
        const { data: seasons, error } = await supabase
          .from("seasons")
          .select("*")
          .order("season_number", { ascending: false });

        if (error) throw error;
        socket.emit("seasons_data", seasons);
      } catch (error) {
        console.error("Error fetching seasons:", error);
        socket.emit("error", "Failed to fetch seasons data");
      }
    });

    // Clean up on disconnect
    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      const subscription = subscriptions.get(socket.id);
      if (subscription) {
        if (subscription.channel) supabase.removeChannel(subscription.channel);
        if (subscription.seasonChannel)
          supabase.removeChannel(subscription.seasonChannel);
        if (subscription.storyChannel)
          supabase.removeChannel(subscription.storyChannel);
      }
      subscriptions.delete(socket.id);
    });
  });

  return io;
}

export { io, initializeSocket };
