import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import { Response } from "express";
import { AppError } from "./app-error";

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof AppError) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as
        string | { message?: string | string[]; error?: string };
      const name =
        typeof body === "object" && body?.error
          ? body.error
          : exception.name.replace(/Exception$/, "");
      const message =
        typeof body === "string"
          ? body
          : Array.isArray(body?.message)
            ? body.message.join("; ")
            : (body?.message ?? exception.message);
      res.status(status).json({
        error: {
          code: HttpErrorFilter.snakeCase(name || "http_error"),
          message,
          details: {},
        },
      });
      return;
    }
    this.logger.error(
      "Unhandled exception",
      exception instanceof Error ? exception.stack : String(exception),
    );
    res
      .status(500)
      .json({
        error: {
          code: "internal_error",
          message: "Internal error",
          details: {},
        },
      });
  }

  private static snakeCase(name: string): string {
    return name
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[\s-]+/g, "_")
      .toLowerCase();
  }
}
