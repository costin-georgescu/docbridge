import { z } from "zod";

export const LoginRequest = z.object({
  email: z.email(),
  password: z.string().min(1).max(128),
});

export type LoginRequest = z.infer<typeof LoginRequest>;

export const TokenResponse = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
});

export type TokenResponse = z.infer<typeof TokenResponse>;

export const ServiceTokenRequest = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

export type ServiceTokenRequest = z.infer<typeof ServiceTokenRequest>;

export const CreateUserRequest = z.object({
  email: z.email(),
  displayName: z.string().min(1).max(200),
  password: z.string().min(8).max(128),
  teamIds: z.array(z.uuid()),
});

export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

export const ReplaceTeamsRequest = z.object({
  teamIds: z.array(z.uuid()),
});

export type ReplaceTeamsRequest = z.infer<typeof ReplaceTeamsRequest>;

export const UserResponse = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  isAdmin: z.boolean(),
  teamIds: z.array(z.uuid()),
  disabledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export type UserResponse = z.infer<typeof UserResponse>;

export const UserListQuery = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

export type UserListQuery = z.infer<typeof UserListQuery>;

export const UserListResponse = z.object({
  items: z.array(UserResponse),
  nextCursor: z.uuid().nullable(),
});

export type UserListResponse = z.infer<typeof UserListResponse>;
