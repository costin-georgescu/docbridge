import { z } from "zod";

export const UserClaims = z.object({
  iss: z.literal("docbridge-auth"),
  aud: z.literal("docbridge"),
  sub: z.uuid(),
  name: z.string(),
  teams: z.array(z.uuid()),
  admin: z.boolean(),
  iat: z.number(),
  exp: z.number(),
});

export type UserClaims = z.infer<typeof UserClaims>;

export const ServiceClaims = z.object({
  iss: z.literal("docbridge-auth"),
  aud: z.literal("docbridge"),
  sub: z.string().regex(/^service:[a-z0-9-]+$/),
  scope: z.array(z.string()),
  iat: z.number(),
  exp: z.number(),
});

export type ServiceClaims = z.infer<typeof ServiceClaims>;

export const TokenClaims = z.union([UserClaims, ServiceClaims]);

export type TokenClaims = z.infer<typeof TokenClaims>;
