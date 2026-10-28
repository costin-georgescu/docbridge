import { Injectable, PipeTransform } from "@nestjs/common";
import { z } from "zod";
import { AppError } from "./app-error";

@Injectable()
export class ZodValidationPipe<T extends z.ZodTypeAny> implements PipeTransform<
  unknown,
  z.infer<T>
> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new AppError(422, "validation_error", "Validation failed", {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
