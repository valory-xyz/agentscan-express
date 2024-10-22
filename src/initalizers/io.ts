import { createAdapter } from "@socket.io/redis-streams-adapter";
import { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { redis } from "./redis";

import dotenv from "dotenv";

dotenv.config();

// Initialize the Socket.IO server
let io: SocketIOServer; // Declare io outside to allow exporting

function initializeSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      methods: ["GET", "POST"],
      credentials: true,
    },
    adapter: createAdapter(redis),
  });

  io.on("connection", (socket) => {
    console.log("A user connected");

    // Add your socket event handlers here...

    socket.on("disconnect", () => {
      console.log("User disconnected");
    });
  });

  return io;
}

// Export the `io` instance and the initialization function
export { io, initializeSocket };
