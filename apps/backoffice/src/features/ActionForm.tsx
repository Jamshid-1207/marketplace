'use client';

import { useHydrated } from '@repo/ui';
import { useTranslations } from 'next-intl';
import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  type FormEvent,
  type ReactNode,
} from 'react';
import { IDLE, type ActionState } from './action-state';

export type FormAction = (state: ActionState, data: FormData) => Promise<ActionState>;

/**
 * Форма с серверным действием: пока оно идёт, поля заблокированы; ошибка API — текстом под
 * формой (SD-08, п. 3.4), успех — коротким «Сохранено». Отправка — через `onSubmit`, а не
 * `<form action>`: React сбрасывал бы поля и после ошибки, и введённое пропадало бы.
 */
export function ActionForm({
  action,
  children,
  className,
  saved = true,
  resetOnSuccess = false,
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
  /** Показывать ли «Сохранено» после успеха. */
  saved?: boolean;
  /** Очистить поля после успеха — форма добавления. */
  resetOnSuccess?: boolean;
}) {
  const t = useTranslations('errors');
  const form = useRef<HTMLFormElement>(null);
  const [state, run, pending] = useActionState(action, IDLE);
  const hydrated = useHydrated();

  useEffect(() => {
    if (resetOnSuccess && state.status === 'ok') form.current?.reset();
  }, [resetOnSuccess, state]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => run(data));
  }

  return (
    <form ref={form} onSubmit={submit} className={className}>
      <fieldset disabled={pending || !hydrated} className="contents">
        {children}
      </fieldset>
      {state.status === 'error' && (
        <p role="alert" className="basis-full text-sm text-red-700">
          {t(state.error)}
          {state.detail && `: ${state.detail}`}
        </p>
      )}
      {saved && state.status === 'ok' && (
        <p role="status" className="basis-full text-sm text-green-700">
          {t('saved')}
        </p>
      )}
    </form>
  );
}
