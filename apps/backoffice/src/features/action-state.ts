/** Ошибки API кабинета — понятным текстом по статусу (SD-08, п. 3.4). */
export const ActionError = [
  'invalid',
  'forbidden',
  'notFound',
  'conflict',
  'unprocessable',
  'failed',
] as const;
export type ActionError = (typeof ActionError)[number];

/** Состояние формы с серверным действием: `useActionState` на клиенте. */
export type ActionState =
  | { status: 'idle' }
  | { status: 'ok'; at: number }
  | { status: 'error'; error: ActionError; detail?: string };

export const IDLE: ActionState = { status: 'idle' };

export const done = (): ActionState => ({ status: 'ok', at: Date.now() });

export const failed = (error: ActionError, detail?: string): ActionState => ({
  status: 'error',
  error,
  ...(detail ? { detail } : {}),
});

const BY_STATUS: Record<number, ActionError> = {
  400: 'invalid',
  403: 'forbidden',
  404: 'notFound',
  409: 'conflict',
  422: 'unprocessable',
};

const EXPLAINED: readonly ActionError[] = ['invalid', 'conflict', 'unprocessable'];

/**
 * Ответ сервиса не 2xx → ошибка формы. Правила предметной области сервисы объясняют по-русски
 * («остаток ниже резерва», «у товара нет SKU») — объяснение показывается рядом. Разбор zod
 * (`✖ …`) — для разработчика: форма проверяет поля до отправки.
 */
export function fromResponse(status: number, body: unknown): ActionState {
  const error = BY_STATUS[status] ?? 'failed';
  const message = (body as { message?: unknown } | null)?.message;
  const explained =
    EXPLAINED.includes(error) && typeof message === 'string' && !message.includes('✖');
  return failed(error, explained ? message : undefined);
}
