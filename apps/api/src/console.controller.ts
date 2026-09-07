import { Controller, Get, Header } from "@nestjs/common";
import { operatorConsoleHtml } from "../../../apps/web/src/operator-console";

@Controller()
export class ConsoleController {
  @Get()
  @Header("content-type", "text/html; charset=utf-8")
  index(): string {
    return operatorConsoleHtml;
  }
}
