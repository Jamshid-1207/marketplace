-- RLS — вторая линия изоляции продавцов (SD-09, п. 5; ADR-0006, п. 9).
-- Роль сервиса работает с app.bypass_tenant = on по умолчанию (infra/postgres/provision.sh);
-- эндпоинты кабинета включают режим магазина: app.bypass_tenant = off и app.seller_id в своей
-- транзакции (libs/auth, tenantAware). FORCE — роль сервиса владеет таблицами (ADR-0004).
-- seller_id сравнивается текстом: пустая настройка не ломает запрос приведением к uuid.

ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_isolation ON warehouses
  USING (
    current_setting('app.bypass_tenant', true) = 'on'
    OR seller_id::text = current_setting('app.seller_id', true)
  );

ALTER TABLE stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_isolation ON stock
  USING (
    current_setting('app.bypass_tenant', true) = 'on'
    OR seller_id::text = current_setting('app.seller_id', true)
  );

ALTER TABLE stock_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_thresholds FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_isolation ON stock_thresholds
  USING (
    current_setting('app.bypass_tenant', true) = 'on'
    OR seller_id::text = current_setting('app.seller_id', true)
  );

ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_isolation ON reservations
  USING (
    current_setting('app.bypass_tenant', true) = 'on'
    OR seller_id::text = current_setting('app.seller_id', true)
  );

ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_isolation ON sales
  USING (
    current_setting('app.bypass_tenant', true) = 'on'
    OR seller_id::text = current_setting('app.seller_id', true)
  );
