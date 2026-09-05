import "reflect-metadata";
import { config as loadDotEnv } from "dotenv";
import { NestFactory } from "@nestjs/core";
import { parseConfig } from "@handoff/config";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  loadDotEnv();
  const config = parseConfig(process.env);
  const app = await NestFactory.create(AppModule.forRoot(config));
  await app.listen(config.port, "0.0.0.0");
}

void bootstrap();
