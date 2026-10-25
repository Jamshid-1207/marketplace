import { z } from 'zod';

/** Роли (ТЗ, 3.1; ADR-0006, п. 2). `libs/auth` берёт их отсюда: источник один. */
export const Role = z.enum(['buyer', 'seller', 'seller_manager', 'admin']);
export type Role = z.infer<typeof Role>;

/** Права сотрудника магазина (ADR-0006, п. 2). `staff` — только у владельца. */
export const SellerPermission = z.enum([
  'catalog',
  'warehouse',
  'orders',
  'support',
  'finance',
  'staff',
]);
export type SellerPermission = z.infer<typeof SellerPermission>;

/** Права сотрудника: хотя бы одно, без повторов по смыслу — их проверяет auth. */
export const StaffScopes = z.array(SellerPermission).min(1).max(SellerPermission.options.length);

/** `GET /seller/staff`: владелец и сотрудники магазина. */
export const StaffMember = z.object({
  userId: z.uuid(),
  email: z.string(),
  role: z.enum(['seller', 'seller_manager']),
  scopes: z.array(SellerPermission),
});
export type StaffMember = z.infer<typeof StaffMember>;

/** `POST /seller/staff`: зарегистрированный пользователь по email (SD-05, п. 5.3). */
export const HireStaffRequest = z.object({ email: z.email().max(254), scopes: StaffScopes });
export type HireStaffRequest = z.infer<typeof HireStaffRequest>;

/** `PUT /seller/staff/:userId`. */
export const StaffScopesRequest = z.object({ scopes: StaffScopes });
export type StaffScopesRequest = z.infer<typeof StaffScopesRequest>;
