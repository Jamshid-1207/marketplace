-- RLS — вторая линия изоляции продавцов (SD-09, п. 5; ADR-0006, п. 9).
-- Роль сервиса работает с app.bypass_tenant = on по умолчанию (infra/postgres/provision.sh);
-- эндпоинты кабинета включают режим магазина: app.bypass_tenant = off и app.seller_id в своей
-- транзакции (libs/auth, tenantAware). FORCE — роль сервиса владеет таблицами (ADR-0004).
-- seller_id сравнивается текстом: пустая настройка не ломает запрос приведением к uuid.

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_isolation ON products
  USING (
    current_setting('app.bypass_tenant', true) = 'on'
    OR seller_id::text = current_setting('app.seller_id', true)
  );

ALTER TABLE skus ENABLE ROW LEVEL SECURITY;
ALTER TABLE skus FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_isolation ON skus
  USING (
    current_setting('app.bypass_tenant', true) = 'on'
    OR seller_id::text = current_setting('app.seller_id', true)
  );
