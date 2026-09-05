import { config as loadDotEnv } from "dotenv";
import { parseConfig } from "@handoff/config";

loadDotEnv();
const config = parseConfig(process.env);
console.log(
  JSON.stringify({
    message: "worker shell ready; inbox processors and outbox dispatcher are deferred to M3/M4",
    environment: config.appEnv,
    adapterMode: config.adapterMode,
  }),
);
