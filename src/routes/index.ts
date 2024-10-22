import express from "express";
import { authMiddleware } from "../middleware/auth";
import gptRouter from "./gpt/index";
//router
const router = express.Router();

//auth route
router.use("/auth", require("./auth").default);
router.use("/user", authMiddleware, require("./user").default);
router.use("/upload", authMiddleware, require("./upload").default);
router.use("/gpt", gptRouter);

router.get("/", (req, res) => {
  res.json({ message: "API is running" });
});

export default router;
