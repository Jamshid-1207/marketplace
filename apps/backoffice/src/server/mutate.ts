import 'server-only';
import { revalidatePath } from 'next/cache';
import { done, failed, fromResponse, type ActionState } from '../features/action-state';
import { GatewayError } from './gateway';

/** Сбой запроса из серверного действия → состояние формы. */
export function rejected(error: unknown): ActionState {
  return error instanceof GatewayError ? fromResponse(error.status, error.body) : failed('failed');
}

/**
 * Изменение через gateway из серверного действия: ошибка — в состояние формы, успех —
 * страница `path` перерисовывается с новыми данными.
 */
export async function mutate(path: string, run: () => Promise<unknown>): Promise<ActionState> {
  try {
    await run();
  } catch (error) {
    return rejected(error);
  }
  revalidatePath(path);
  return done();
}
