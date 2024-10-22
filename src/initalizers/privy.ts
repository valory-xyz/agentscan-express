import { PrivyClient } from "@privy-io/server-auth";

import dotenv from "dotenv";

dotenv.config();

const privy = new PrivyClient(
  process.env.PRIVY_APP_ID as string,
  process.env.PRIVY_APP_SECRET as string
);

export default privy;
