import express from "express";
import { createServer } from "http";
import { config } from "./config";
import { redis } from "./initalizers/redis";

import {
  addEmojiReaction,
  createMessage,
  getChannelMessageHistory,
  getMessageById,
  readMessages,
  removeEmojiReaction,
} from "./services/messages";
import cors from "cors";
import { pool } from "./initalizers/postgres";
import privy from "./initalizers/privy";
import { initializeSocket, io } from "./initalizers/io";
import { getUsersByIds } from "./services/user";
import { removeUserOnline, setUserOnline } from "./services/onlineStatus";
import dotenv from "dotenv";
import { Socket } from "socket.io";

dotenv.config();

const ONLINE_STATUS_TTL = 3600; // 1 hour in seconds
const HEARTBEAT_INTERVAL = 300000; // 5 minutes in milliseconds

const app = express();
const httpServer = createServer(app);

initializeSocket(httpServer);

// Middleware

// Increase payload size limit to 10MB (adjust as needed)
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

//this should work on localhost
app.use(cors());

// Routes
app.use("/", require("./routes").default);

const socketAuthMiddleware = async (
  socket: Socket,
  next: (err?: Error) => void
) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    console.error("Authentication error: No token provided");
    return next(new Error("Authentication error: No token provided"));
  }

  try {
    // Verify the token using Privy
    const verifiedClaims = await privy.verifyAuthToken(token);
    const privy_did = verifiedClaims.userId;

    // Check if user is in Redis cache
    let user = null;
    const cachedUser = await redis.get(`user:${privy_did}`);
    if (cachedUser) {
      user = JSON.parse(cachedUser);
    } else {
      // Check if the user exists in our database using the privy_did column
      const userResult = await pool.query(
        "SELECT * FROM users WHERE privy_did = $1",
        [privy_did]
      );

      if (userResult.rows.length === 0) {
        return next(new Error("Authentication error: User not found"));
      }

      user = userResult.rows[0];

      // Cache the user in Redis
      redis.set(`user:${privy_did}`, JSON.stringify(user), {
        EX: 1800, // 30 minutes
      });
    }

    // Attach the user to the socket data
    socket.data.user = user;
    return next();
  } catch (error) {
    console.log("Error in socket auth middleware:", error);
    if (error instanceof Error && error.name === "PrivyValidationError") {
      return next(new Error("Authentication error: Invalid token"));
    }
    return next(new Error("Internal server error"));
  }
};

// Apply the authentication middleware to Socket.IO
io.use(socketAuthMiddleware);

// Socket.IO event handling
io.on("connection", (socket) => {
  const userId = socket.data.user.id;

  const updateUserOnline = async () => {
    await setUserOnline(userId, ONLINE_STATUS_TTL);
    io.emit("user_status_change", { userId, status: "online" });
  };

  // Set user as online when they connect
  updateUserOnline();

  // Set up heartbeat
  const heartbeatInterval = setInterval(updateUserOnline, HEARTBEAT_INTERVAL);

  // Update the socket.io "join channel" event handler
  socket.on("join channel", async (channelId) => {
    socket.join(channelId);

    try {
      const { messages, nextCursor } = await getChannelMessageHistory(
        channelId,
        50,
        "NOW()"
      );
      socket.emit("channel history", { channelId, messages, nextCursor });
    } catch (error) {
      console.error("Error fetching channel history:", error);
    }
  });

  socket.on(
    "add reaction",
    async (data: { messageId: string; emoji: string; userId: any }) => {
      try {
        const { messageId, emoji, userId } = data;

        await addEmojiReaction(messageId, userId, emoji);

        // Emit the updated reaction to all clients in the channel
        const message = await getMessageById(messageId);
        //hydrate user
        const userData = await getUsersByIds([userId]);

        //get key of user
        const user = userData.get(userId);
        if (message) {
          io.to(message.channel_id).emit("reaction updated", {
            messageId,
            emoji,
            user,
            action: "add",
          });
        }
      } catch (error) {
        console.error("Error adding reaction:", error);
        socket.emit("reaction error", { error: "Failed to add reaction" });
      }
    }
  );

  socket.on(
    "remove reaction",
    async (data: { messageId: string; emoji: string; userId: any }) => {
      try {
        const { messageId, emoji, userId } = data;

        await removeEmojiReaction(messageId, userId, emoji);

        // Emit the updated reaction to all clients in the channel
        const message = await getMessageById(messageId);
        //hydrate user
        const userData = await getUsersByIds([userId]);

        //get key of user
        const user = userData.get(userId);
        if (message) {
          io.to(message.channel_id).emit("reaction updated", {
            messageId,
            emoji,
            user,
            action: "remove",
          });
        }
      } catch (error) {
        console.error("Error removing reaction:", error);
        socket.emit("reaction error", { error: "Failed to remove reaction" });
      }
    }
  );

  socket.on("leave channel", (channelId) => {
    socket.leave(channelId);
    console.log(`User left channel: ${channelId}`);
  });

  socket.on("chat message", async (message) => {
    try {
      createMessage(
        message.channel_id,
        socket.data.user.id,
        message.content,
        message.embeds,
        message.parent_id
      );
    } catch (error) {
      console.error("Error creating message:", error);
      socket.emit("message error", { error: "Failed to create message" });
    }
  });

  socket.on("start typing", (channelId, userId, username) => {
    socket.to(channelId).emit("typing", { userId, username, isTyping: true });
  });

  socket.on("stop typing", (channelId, userId, username) => {
    socket.to(channelId).emit("typing", { userId, username, isTyping: false });
  });

  socket.on("disconnect", async () => {
    clearInterval(heartbeatInterval);
    await removeUserOnline(userId);
    io.emit("user_status_change", { userId, status: "offline" });
  });
});

// Initialize the server
async function initServer(): Promise<void> {
  // await createConsumerGroup();

  // const initialChannels = await fetchAllChannels();
  // initialChannels.forEach((channel: any) => {
  //   setInterval(() => readMessages(channel?.id), 100);
  // });

  // listenForNewChannels();

  httpServer.listen(config.server.port, () => {
    console.log(`Server running on port ${config.server.port}`);
  });
}

initServer().catch(console.error);
