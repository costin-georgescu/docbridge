import { z } from "zod";
import { baseEnvSchema, loadConfig } from "@docbridge/config";

export const config = loadConfig(
  baseEnvSchema.extend({ PORT: z.coerce.number().int().default(3002) }),
);
