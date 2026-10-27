import { z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseOr400<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error));
  return result.data;
}

const uuid = z.uuid();

/** Ids are uuids; anything else cannot exist, so it is a 404 rather than a database error. */
export function idOr404(value: string): string {
  if (!uuid.safeParse(value).success) throw new HttpError(404, "not found");
  return value;
}
