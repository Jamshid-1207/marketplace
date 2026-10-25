-- RLS — вторая линия изоляции продавцов (SD-09, п. 5; ADR-0006, п. 9).
-- Роль сервиса работает с app.bypass_tenant = on по умолчанию (infra/postgres/provision.sh);
-- эндпоинты кабинета включают режим магазина: app.bypass_tenant = off и app.seller_id в своей
-- транзакции (libs/auth, tenantAware). FORCE — роль сервиса владеет таблицами (ADR-0004).
-- seller_id сравнивается текстом: пустая настройка не ломает запрос приведением к uuid.

ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_isolation ON ledger_entries
  USING (
    current_setting('app.bypass_tenant', true) = 'on'
    OR seller_id::text = current_setting('app.seller_id', true)
  );

ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_isolation ON settlements
  USING (
    current_setting('app.bypass_tenant', true) = 'on'
    OR seller_id::text = current_setting('app.seller_id', true)
  );

ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_isolation ON payouts
  USING (
    current_setting('app.bypass_tenant', true) = 'on'
    OR seller_id::text = current_setting('app.seller_id', true)
  );
