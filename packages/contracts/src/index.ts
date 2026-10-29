import { z } from "zod";

export const HealthResponse = z.object({
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof HealthResponse>;

export * from "./errors";
export * from "./claims";
export * from "./auth";
export * from "./platform";
export * from "./uploads";
