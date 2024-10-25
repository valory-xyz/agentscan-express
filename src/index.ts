import express from "express";
import { createServer } from "http";
import { config } from "./config";
import { redis } from "./initalizers/redis";

import cors from "cors";
import { pool } from "./initalizers/postgres";
import privy from "./initalizers/privy";
import { initializeSocket, io } from "./initalizers/io";
import { getUsersByIds } from "./services/user";
import { removeUserOnline, setUserOnline } from "./services/onlineStatus";
import dotenv from "dotenv";
import { Socket } from "socket.io";

dotenv.config();

const app = express();
const httpServer = createServer(app);

initializeSocket(httpServer);

// Middleware

// Increase payload size limit to 10MB (adjust as needed)
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

app.use(cors());

app.use("/", require("./routes").default);

// Initialize the server
async function initServer(): Promise<void> {
  httpServer.listen(config.server.port, () => {
    console.log(`Server running on port ${config.server.port}`);
  });
}

initServer().catch(console.error);
