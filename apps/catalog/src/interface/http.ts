import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
} from '../application/errors';

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(z.prettifyError(result.error));
  return result.data;
}

/** Ошибки use case'ов → HTTP. */
export async function http<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof NotFoundError) throw new NotFoundException(error.message);
    if (error instanceof ConflictError) throw new ConflictException(error.message);
    if (error instanceof InvalidRequestError) throw new BadRequestException(error.message);
    if (error instanceof ForbiddenError) throw new ForbiddenException(error.message);
    throw error;
  }
}
