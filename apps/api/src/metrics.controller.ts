import { Controller, Get, Header, Inject } from "@nestjs/common";
import { MetricsRegistry } from "@handoff/observability";
import { METRICS } from "./tokens";

@Controller()
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: MetricsRegistry) {}

  @Get("metrics")
  @Header("content-type", "application/json")
  structured(): ReturnType<MetricsRegistry["snapshot"]> {
    return this.metrics.snapshot();
  }

  @Get("metrics/prometheus")
  @Header("content-type", "text/plain; version=0.0.4")
  prometheus(): string {
    return this.metrics.renderPrometheus();
  }
}
