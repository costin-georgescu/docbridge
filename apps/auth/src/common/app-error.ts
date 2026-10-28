import { HttpException } from "@nestjs/common";
import { ErrorCode, ErrorResponse } from "@docbridge/contracts";

export class AppError extends HttpException {
  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(ErrorResponse.parse({ error: { code, message, details } }), status);
  }
}
