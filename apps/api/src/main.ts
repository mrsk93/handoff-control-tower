import "reflect-metadata";
import { config as loadDotEnv } from "dotenv";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { parseConfig } from "@handoff/config";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  loadDotEnv();
  const config = parseConfig(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    rawBody: true,
    bodyParser: false,
  });
  app.useBodyParser("json", { limit: `${config.ingestMaxBodyBytes}b` });
  await app.listen(config.port, "0.0.0.0");
}

void bootstrap();
