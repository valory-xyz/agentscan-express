import express from "express";
import supabase from "../../config/supabaseClient";

const router = express.Router();

router.get("/", async (req: express.Request, res: express.Response) => {
  const fid = req.query.fid as string;
  console.log("fid", fid);

  const { data, error } = await supabase
    .from("descriptions")
    .select("*")
    .eq("fid", fid);
  console.log("data", data);
  console.log("error", error);

  if (data && data.length > 0) {
    const user = data[0];
    res.status(200).send({ user });
  } else {
    res.status(404).send({ message: "User not found" });
  }
});

router.post("/", async (req: express.Request, res: express.Response) => {
  try {
    const { fid, type } = req.body;
    const { data, error } = await supabase
      .from("descriptions")
      .select("*")
      .eq("fid", fid);

    if (data && data.length > 0) {
      const user = data[0];
      res.status(200).send({ user });
      return;
    }

    const profileCreationPrompt = `
      // ... existing prompt ...
    `;

    const finalPrompt = profileCreationPrompt;
    if (!finalPrompt) {
      throw new Error("Failed to generate summary prompt");
    }

    // ... existing commented out code ...

    res.json({ message: "Data processed successfully", data });
  } catch (error: any) {
    console.log("Error:", error);
    res.status(500).send(error.message);
  }
});

export default router;
