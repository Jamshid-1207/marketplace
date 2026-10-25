import { DEV_CATALOG, devUser } from '@repo/contracts';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DEV_PASSWORD, login, postOrder, psp, untilPaymentPage, untilStatus } from '../support/api';
import { newUser } from '../support/catalog';

const BACKOFFICE_URL = process.env.E2E_BACKOFFICE_URL ?? 'http://localhost:3002';
const STOREFRONT_URL = process.env.E2E_STOREFRONT_URL ?? 'http://localhost:3001';
/** Пароль пользователей, которых заводит `newUser`. */
const NEW_USER_PASSWORD = 'e2e-password-1';

const [phone] = DEV_CATALOG; // товар магазина A
const tag = randomUUID().slice(0, 6);
const shopName = `Магазин UI ${tag}`;
const productTitle = `Сковорода UI ${tag}`;
const skuCode = `PAN-${tag}`;
const category = `Категория UI ${tag}`;
const shipping = {
  recipientName: 'Покупатель кабинета',
  phone: '+998901234567',
  address: `Ташкент, ул. Кабинетная, ${tag}`,
};

const email = (login: string) => devUser(login)?.email as string;
const main = (page: Page) => page.getByRole('main');
const menu = (page: Page) => page.getByRole('complementary');

/** Свой контекст на пользователя: у кабинета своя сессия в cookie (SD-08, п. 3.1). */
async function signIn(browser: Browser, address: string, password: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: BACKOFFICE_URL, locale: 'ru-RU' });
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Вход в кабинет' })).toBeVisible();
  await page.getByLabel('Email').fill(address);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(menu(page)).toBeVisible();
  return page;
}

/**
 * Критерий этапа 8 (SD-08, п. 1): действия MVP кабинета и админки через UI. Сценарии идут по
 * порядку: новый магазин из первого живёт до блокировки в последнем.
 */
test.describe.serial('кабинет и админка в браузере', () => {
  let owner: Page;
  let admin: Page;
  let productId = '';

  test.afterAll(async () => {
    await owner?.context().close();
    await admin?.context().close();
  });

  test('11, 1. без магазина — только «Открыть магазин»; магазин на модерации, кабинет открыт сразу', async ({
    browser,
  }) => {
    const user = await newUser('ui-shop');
    owner = await signIn(browser, user.email, NEW_USER_PASSWORD);
    await expect(main(owner).getByText(/У вас нет магазина/)).toBeVisible();
    await expect(menu(owner).getByRole('link')).toHaveText(['Сводка', 'Открыть магазин']);
    await owner.goto('/products');
    await expect(owner.getByRole('heading', { name: 'Нет доступа к этому разделу' })).toBeVisible();

    await owner.goto('/open-shop');
    await owner.getByLabel('Название магазина').fill(shopName);
    await owner.getByRole('button', { name: 'Открыть магазин' }).click();
    // токен обновлён сразу (решение 4): страница магазина читается с ролью владельца
    await expect(owner.getByRole('heading', { level: 1, name: shopName })).toBeVisible();
    await expect(main(owner).getByText('На модерации', { exact: true })).toBeVisible();
    await expect(menu(owner).getByRole('link', { name: 'Товары' })).toBeVisible();
    await expect(menu(owner).getByRole('link', { name: 'Сотрудники' })).toBeVisible();
  });

  test('2. товар: черновик, SKU с ценой и атрибутами, ссылка на изображение, на модерацию', async () => {
    await owner.goto('/products/new');
    await owner.getByLabel('Название').fill(productTitle);
    await owner.getByLabel('Категория').selectOption({ label: 'Дом / Кухня' });
    await owner.getByLabel('Описание').fill('Чугунная, 28 см');
    await owner.getByLabel('Изображения').fill('https://img.example/pan.jpg');
    await owner.getByRole('button', { name: 'Создать черновик' }).click();
    await owner.waitForURL(/\/products\/[0-9a-f-]{36}$/);
    productId = new URL(owner.url()).pathname.split('/').pop() as string;
    await expect(main(owner).getByText('Черновик', { exact: true })).toBeVisible();

    const add = owner.getByRole('group', { name: 'Новый вариант' });
    await add.getByLabel('Код').fill(skuCode);
    await add.getByLabel('Атрибуты').fill('Диаметр: 28 см');
    await add.getByLabel('Цена, сум').fill('450 000');
    await add.getByRole('button', { name: 'Добавить' }).click();
    const sku = owner.getByRole('group', { name: skuCode });
    await expect(sku.getByLabel('Цена, сум')).toHaveValue('450 000');
    await expect(sku.getByLabel('Атрибуты')).toHaveValue('Диаметр: 28 см');

    await owner.getByRole('button', { name: 'Отправить на модерацию' }).click();
    await expect(main(owner).getByText('На модерации', { exact: true })).toBeVisible();
  });

  test('1, 9. админ одобряет магазин и товар — товар на витрине', async ({ browser }) => {
    admin = await signIn(browser, email('admin'), DEV_PASSWORD);
    await admin.goto('/admin/sellers');
    const pending = admin.getByRole('region', { name: shopName });
    await pending.getByRole('button', { name: 'Одобрить' }).click();
    await expect(pending).toHaveCount(0);
    await admin.goto('/admin/sellers?status=active');
    await expect(admin.getByRole('region', { name: shopName })).toBeVisible();

    await admin.goto('/admin/products');
    const card = admin.getByRole('region', { name: productTitle });
    await expect(card.getByText('450 000 сум')).toBeVisible();
    await expect(card.getByRole('link', { name: 'https://img.example/pan.jpg' })).toBeVisible();
    await card.getByRole('button', { name: 'Одобрить' }).click();
    await expect(card).toHaveCount(0);

    await owner.reload();
    await expect(main(owner).getByText('Опубликован', { exact: true })).toBeVisible();
    const storefront = await owner.context().newPage();
    await storefront.goto(`${STOREFRONT_URL}/products/${productId}`);
    await expect(storefront.getByRole('heading', { name: productTitle })).toBeVisible();
    await storefront.close();
  });

  test('3, 2. правка опубликованного: цена — сразу, текст — снова на модерацию; отказ с причиной', async () => {
    await owner.goto(`/products/${productId}`);
    const sku = owner.getByRole('group', { name: skuCode });
    await sku.getByLabel('Цена, сум').fill('399 000');
    await sku.getByRole('button', { name: 'Сохранить' }).click();
    await expect(sku.getByText('Сохранено')).toBeVisible();
    await expect(main(owner).getByText('Опубликован', { exact: true })).toBeVisible();

    const content = owner.getByRole('region', { name: 'Описание' });
    await content.getByLabel('Описание').fill('Чугунная, 28 см, с крышкой');
    await content.getByRole('button', { name: 'Сохранить' }).click();
    await expect(main(owner).getByText('На модерации', { exact: true })).toBeVisible();

    await admin.goto('/admin/products');
    const card = admin.getByRole('region', { name: productTitle });
    await expect(card.getByText('399 000 сум')).toBeVisible();
    await card.getByLabel('Причина отказа').fill('Нет фото крышки');
    await card.getByRole('button', { name: 'Отклонить' }).click();
    await expect(card).toHaveCount(0);

    await owner.reload();
    await expect(main(owner).getByText('Отклонён', { exact: true })).toBeVisible();
    await expect(owner.getByText('Модерация отклонила товар: Нет фото крышки')).toBeVisible();
  });

  test('4. склад, приход, списание ниже резерва — понятная ошибка, порог; остатки с названием', async () => {
    await owner.goto('/stock');
    const warehouses = owner.getByRole('region', { name: 'Склады' });
    await warehouses.getByLabel('Новый склад').fill(`Склад ${tag}`);
    await warehouses.getByRole('button', { name: 'Добавить склад' }).click();
    const name = warehouses.getByRole('textbox', { name: 'Название' });
    await expect(name).toHaveValue(`Склад ${tag}`);
    await warehouses.getByRole('spinbutton', { name: 'Приоритет' }).first().fill('2');
    await warehouses.getByRole('button', { name: 'Сохранить' }).click();
    await expect(warehouses.getByText('Сохранено')).toBeVisible();

    const row = owner.getByRole('region', { name: `${productTitle} ${skuCode}` });
    await row.getByLabel('Склад').selectOption({ label: `Склад ${tag}` });
    await row.getByLabel('Количество').fill('5');
    await row.getByLabel('Причина').fill('приход');
    await row.getByRole('button', { name: 'Провести' }).click();
    await expect(row.getByRole('row', { name: /Всего/ })).toHaveText(/Всего\s*5\s*0\s*5/);

    await row.getByLabel('Количество').fill('-10');
    await row.getByLabel('Причина').fill('списание');
    await row.getByRole('button', { name: 'Провести' }).click();
    await expect(row.getByRole('alert')).toContainText('Действие сейчас недоступно');
    await expect(row.getByRole('alert')).toContainText('меньше зарезервированного');

    await row.getByLabel('Порог').fill('10');
    await row.getByRole('button', { name: 'Сохранить' }).click();
    await expect(row.getByText('Низкий остаток')).toBeVisible();
  });

  test('5, 6, 7, 11. магазин A: заказ — отгрузка и доставка, финансы, покупатели; чужое — «не найдено»', async ({
    browser,
  }) => {
    const buyer = await login('buyer-1');
    const order = await postOrder(buyer, {
      body: { lines: [{ skuId: phone.skuId, qty: 1 }], shipping },
    });
    expect(order.status).toBe(202);
    await psp.act(await untilPaymentPage(buyer, order.body.orderId), 'authorize');
    const confirmed = await untilStatus(buyer, order.body.orderId, 'CONFIRMED');
    const subOrderId = confirmed.subOrders[0].subOrderId;

    const sellerA = await signIn(browser, email('seller-a'), DEV_PASSWORD);
    await sellerA.goto('/orders?status=CONFIRMED');
    await expect(main(sellerA).getByRole('link', { name: 'К отгрузке' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await sellerA.goto(`/orders/${subOrderId}`);
    await expect(main(sellerA).getByText(shipping.address)).toBeVisible();
    await expect(main(sellerA).getByText(email('buyer-1'))).toHaveCount(0);
    await main(sellerA).getByRole('button', { name: 'Отгрузить' }).click();
    await expect(main(sellerA).getByText('Отгружен', { exact: true })).toBeVisible();
    await main(sellerA).getByRole('button', { name: 'Доставлен' }).click();
    // кнопка «Доставлен» пропала — остался статус с тем же текстом
    await expect(main(sellerA).getByRole('button')).toHaveCount(0);
    await expect(main(sellerA).getByText('Доставлен', { exact: true })).toBeVisible();

    await sellerA.goto('/finance');
    await expect(main(sellerA).getByText(/через 5 секунд после доставки/)).toBeVisible();
    await expect(main(sellerA).getByText(/Минимальная выплата — 100 000 сум/)).toBeVisible();
    await expect(main(sellerA).getByRole('cell', { name: 'Оплата заказа' }).first()).toBeVisible();
    const amount = main(sellerA).getByLabel('Сумма, сум');
    await amount.fill('1');
    await main(sellerA).getByRole('button', { name: 'Запросить выплату' }).click();
    await expect(main(sellerA).getByRole('alert')).toContainText('Не выполнено');
    await amount.fill('999 999 999');
    await main(sellerA).getByRole('button', { name: 'Запросить выплату' }).click();
    await expect(main(sellerA).getByRole('alert')).toContainText('Действие сейчас недоступно');

    await sellerA.goto('/customers');
    await main(sellerA)
      .getByRole('link', { name: /^Покупатель …/ })
      .first()
      .click();
    await expect(sellerA.getByRole('heading', { level: 1, name: 'Покупатель' })).toBeVisible();
    await expect(main(sellerA).getByText(/@/)).toHaveCount(0);
    await sellerA.goto('/customers?segment=vip');
    await expect(main(sellerA).getByRole('link', { name: 'VIP' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // изоляция (ADR-0006, п. 4): товар нового магазина и под-заказ магазина A — чужие
    const sellerB = await signIn(browser, email('seller-b'), DEV_PASSWORD);
    await sellerB.goto(`/products/${productId}`);
    await expect(sellerB.getByRole('heading', { name: 'Не найдено' })).toBeVisible();
    await sellerB.goto(`/orders/${subOrderId}`);
    await expect(sellerB.getByRole('heading', { name: 'Не найдено' })).toBeVisible();
    await Promise.all([sellerA.context().close(), sellerB.context().close()]);
  });

  test('8. сотрудник: только разделы своих прав; права поменяли — меню сразу другое', async ({
    browser,
  }) => {
    const user = await newUser('ui-staff');
    await owner.goto('/staff');
    const hire = owner.getByRole('region', { name: 'Добавить сотрудника' });
    await hire.getByLabel('Email').fill(user.email);
    await expect(hire.getByLabel('Заказы')).toBeChecked();
    await hire.getByRole('button', { name: 'Добавить' }).click();
    const member = owner.getByRole('group', { name: user.email });
    await expect(member.getByText('Сотрудник', { exact: true })).toBeVisible();

    const employee = await signIn(browser, user.email, NEW_USER_PASSWORD);
    await expect(menu(employee).getByRole('link')).toHaveText(['Сводка', 'Заказы']);
    await employee.goto('/products');
    await expect(
      employee.getByRole('heading', { name: 'Нет доступа к этому разделу' }),
    ).toBeVisible();

    await member.getByLabel('Заказы').uncheck();
    await member.getByLabel('Покупатели').check();
    await member.getByRole('button', { name: 'Сохранить права' }).click();
    await expect(member.getByText('Сохранено')).toBeVisible();
    await employee.goto('/');
    await expect(menu(employee).getByRole('link')).toHaveText(['Сводка', 'Покупатели']);

    await member.getByRole('button', { name: 'Убрать из магазина' }).click();
    await expect(member).toHaveCount(0);
    await employee.context().close();
  });

  test('10. админка: категории, ставка комиссии, отчёт, сверка журнала, покупатели 360°', async () => {
    await admin.goto('/admin/categories');
    const create = admin.getByRole('region', { name: 'Новая категория' });
    await create.getByLabel('Название').fill(category);
    await create.getByLabel('Где').selectOption({ label: 'Дом' });
    await create.getByRole('button', { name: 'Создать' }).click();
    const created = admin.locator('form', { has: admin.locator(`input[value="${category}"]`) });
    await expect(created).toHaveCount(1);
    await created.getByRole('textbox').fill(`${category} 2`);
    await created.getByRole('button', { name: 'Переименовать' }).click();
    await expect(admin.locator(`input[value="${category} 2"]`)).toHaveCount(1);

    // новую категорию payment узнаёт событием catalog: пока не узнал, ставка — «не найдено»
    await expect(async () => {
      await admin.goto('/admin/commission');
      const rate = admin.getByLabel(`Ставка: Дом / ${category} 2`);
      await rate.fill('7,5');
      const rateForm = admin.locator('form', { has: rate });
      await rateForm.getByRole('button', { name: 'Сохранить' }).click();
      await expect(rateForm.getByText('Сохранено')).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    await admin.reload();
    await expect(admin.getByLabel(`Ставка: Дом / ${category} 2`)).toHaveValue('7,5');
    await expect(main(admin).getByText('Заработано')).toBeVisible();
    await main(admin).getByRole('link', { name: 'Проверить журнал' }).click();
    await expect(main(admin).getByText('Инварианты журнала выполнены')).toBeVisible();

    await admin.goto('/admin/customers');
    await admin.getByRole('searchbox', { name: 'Email' }).fill(email('buyer-1'));
    await admin.getByRole('button', { name: 'Найти' }).click();
    await main(admin)
      .getByRole('link', { name: email('buyer-1') })
      .click();
    await expect(admin.getByRole('heading', { level: 1, name: email('buyer-1') })).toBeVisible();
    await expect(main(admin).getByText('Оплачено')).toBeVisible();
  });

  test('9. блокировка магазина: разделы кабинета владельца закрыты', async () => {
    await admin.goto('/admin/sellers?status=active');
    const shop = admin.getByRole('region', { name: shopName });
    await shop.getByLabel('Причина').fill('Нарушение правил');
    await shop.getByRole('button', { name: 'Заблокировать' }).click();
    await expect(shop).toHaveCount(0);

    // статус магазина auth узнаёт событием catalog — меню закрывается, когда оно дошло
    await expect(async () => {
      await owner.goto('/');
      await expect(
        main(owner).getByText('Магазин не работает: разделы кабинета закрыты'),
      ).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 60_000 });
    await expect(menu(owner).getByRole('link', { name: 'Товары' })).toHaveCount(0);
  });
});
