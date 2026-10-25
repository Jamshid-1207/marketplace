'use server';

import { HireStaffRequest, StaffMember, StaffScopesRequest } from '@repo/contracts';
import { gateway } from '../../server/gateway';
import { mutate } from '../../server/mutate';
import { failed, type ActionState } from '../action-state';

const PAGE = '/staff';
const scopes = (data: FormData) => data.getAll('scopes').map(String);

/** Сотрудник — зарегистрированный пользователь без своего магазина; занятый — `409` (SD-05, п. 5.3). */
export async function hireStaff(_: ActionState, data: FormData): Promise<ActionState> {
  const body = HireStaffRequest.safeParse({
    email: String(data.get('email') ?? '').trim(),
    scopes: scopes(data),
  });
  if (!body.success) return failed('invalid');
  return mutate(PAGE, () =>
    gateway('/seller/staff', { method: 'POST', body: body.data, schema: StaffMember }),
  );
}

/** Новые права действуют в API со следующим обновлением токена сотрудника — до 15 минут. */
export async function setStaffScopes(
  userId: string,
  _: ActionState,
  data: FormData,
): Promise<ActionState> {
  const body = StaffScopesRequest.safeParse({ scopes: scopes(data) });
  if (!body.success) return failed('invalid');
  return mutate(PAGE, () =>
    gateway(`/seller/staff/${userId}`, { method: 'PUT', body: body.data, schema: StaffMember }),
  );
}

export async function removeStaff(userId: string): Promise<ActionState> {
  return mutate(PAGE, () => gateway(`/seller/staff/${userId}`, { method: 'DELETE' }));
}
