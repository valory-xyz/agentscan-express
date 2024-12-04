import express from "express";
import { authMiddleware } from "../middleware/auth";
import { authAndRateLimit } from "../middleware/rateLimiter";

//router
const router = express.Router();

//auth route
router.use("/auth", require("./auth").default);
router.use("/user", authMiddleware, require("./user").default);
router.use(
  "/conversation",
  (req: any, res: any, next: any) => authMiddleware(req, res, next, true),
  (req: any, res: any, next: any) =>
    authAndRateLimit(req, res, next, req?.user),
  require("./conversation").default
);
router.use("/agent", require("./agent").default);
router.use("/crawl", require("./crawl").default);
router.get("/", (req, res) => {
  res.json({ message: "API is running" });
});

export default router;
