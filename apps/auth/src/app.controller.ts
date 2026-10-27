import { Controller, Get } from "@nestjs/common";
import { HealthResponse } from "@docbridge/contracts";

@Controller()
export class AppController {
  @Get("health")
  health(): HealthResponse {
    return HealthResponse.parse({ status: "ok" });
  }
}
