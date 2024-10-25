// server-side socket initialization
import { createAdapter } from "@socket.io/redis-streams-adapter";
import { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { redis } from "./redis";

import { normalizeCharacters } from "../services/characters";
import supabase from "./supabaseClient";

interface SocketSubscription {
  seasonId?: string;
  channel?: any;
}

const subscriptions = new Map<string, SocketSubscription>();

let io: SocketIOServer;

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
    console.log("User connected:", socket.id);
    subscriptions.set(socket.id, {});

    async function setupCharacterSubscription(seasonId?: string) {
      try {
        const query = supabase
          .from("characters")
          .select("*")
          .order("created_at", { ascending: false });

        if (seasonId) {
          query.eq("season_id", seasonId);
        }

        const { data: characters, error } = await query;
        if (error) throw error;
        const normalizedCharacters = normalizeCharacters(characters);
        console.log(normalizedCharacters);

        // First send a reset signal, then the new data
        socket.emit("characters_reset");
        socket.emit("initial_characters", normalizedCharacters);

        const subscription = subscriptions.get(socket.id);
        if (subscription) {
          // Clean up existing subscription if any
          if (subscription.channel) {
            supabase.removeChannel(subscription.channel);
          }

          // Create new subscription
          const channel = supabase
            .channel(`characters-${socket.id}`)
            .on(
              "postgres_changes",
              {
                event: "*",
                schema: "public",
                table: "characters",
                ...(seasonId && { filter: `season_id=eq.${seasonId}` }),
              },
              (payload: any) => {
                if (!seasonId || payload.new?.season_id === seasonId) {
                  const normalizedCharacter = normalizeCharacters([
                    payload.new || payload.old,
                  ]);
                  console.log("normalizedCharacter", normalizedCharacter);
                  const newCharacter = normalizedCharacter[0];
                  console.log("new character", newCharacter);

                  socket.emit("character_update", {
                    type: payload.eventType,
                    data: newCharacter,
                  });
                }
              }
            )
            .subscribe((status) => {
              console.log(`Subscription status for ${socket.id}:`, status);
            });

          // Update subscription tracking
          subscriptions.set(socket.id, {
            seasonId,
            channel,
          });
        }
      } catch (error) {
        console.log("Error setting up character subscription:", error);
        console.error("Error setting up character subscription:", error);
        socket.emit("error", "Failed to fetch characters");
      }
    }

    // Handle initial characters request
    socket.on("request_characters", async (seasonId?: string) => {
      await setupCharacterSubscription(seasonId);
    });

    // Handle season changes
    socket.on("change_season", async (seasonId: string) => {
      await setupCharacterSubscription(seasonId);
    });

    // Clean up on disconnect
    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      const subscription = subscriptions.get(socket.id);
      if (subscription?.channel) {
        supabase.removeChannel(subscription.channel);
      }
      subscriptions.delete(socket.id);
    });
  });

  return io;
}

export { io, initializeSocket };
