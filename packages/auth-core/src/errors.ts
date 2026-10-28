import { HttpException } from "@nestjs/common";
import { ErrorResponse } from "@docbridge/contracts";

export class AuthError extends HttpException {
  constructor(
    status: 401 | 403,
    code: "unauthorized" | "forbidden",
    message: string,
  ) {
    super(
      ErrorResponse.parse({ error: { code, message, details: {} } }),
      status,
    );
  }
}
