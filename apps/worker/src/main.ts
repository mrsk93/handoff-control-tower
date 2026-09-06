import { config as loadDotEnv } from "dotenv";
import { parseConfig } from "@handoff/config";

loadDotEnv();
const config = parseConfig(process.env);
console.log(
  JSON.stringify({
    message:
      "worker shell ready; transactional outbox dispatcher is available through @handoff/queue",
    environment: config.appEnv,
    adapterMode: config.adapterMode,
  }),
);
