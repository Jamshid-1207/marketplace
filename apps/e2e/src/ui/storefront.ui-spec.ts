import { DEV_CATALOG } from '@repo/contracts';
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const [phone, , kettle] = DEV_CATALOG; // магазин A и магазин B
const JAEGER_URL = process.env.E2E_JAEGER_URL ?? 'http://localhost:16686';
const PSP_ORIGIN = new URL(process.env.E2E_PSP_URL ?? 'http://localhost:4000').origin;

const password = 'e2e-password-1';

async function addToCart(page: Page, productId: string) {
  await page.goto(`/products/${productId}`);
  await expect(page.getByText('В наличии', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'В корзину' }).click();
  await expect(page.getByText('Добавлено в корзину')).toBeVisible();
}

async function register(page: Page) {
  const email = `ui-${randomUUID().slice(0, 8)}@e2e.test`;
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  return email;
}

async function fillShipping(page: Page) {
  await page.getByLabel('Получатель').fill('Покупатель витрины');
  await page.getByLabel('Телефон').fill('90 123-45-67');
  await page.getByLabel('Адрес').fill('Ташкент, ул. Тестовая, 5');
}

/** Страница оплаты fake-psp: «Оплатить» или «Отклонить». */
async function onPaymentPage(page: Page) {
  await page.waitForURL((url) => url.origin === PSP_ORIGIN, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Оплата заказа' })).toBeVisible();
}

const status = (page: Page) => page.getByTestId('order-status');

/**
 * Критерий этапа 7 (SD-07, п. 1): покупка от каталога до «Моих заказов» через UI. Сценарии
 * идут по порядку: отмена под-заказа и выход работают с покупателем первого сценария.
 */
test.describe.serial('витрина в браузере', () => {
  let orderUrl = '';

  test('1, 2. каталог: поиск, категория, карточка с ценой и наличием', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Каталог' })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Найти товар' }).fill('чайник');
    await page.getByRole('button', { name: 'Найти' }).click();
    await expect(page.getByRole('heading', { name: 'Найдено по запросу «чайник»' })).toBeVisible();
    // точное название: товары других сценариев называются «Чайник электрический <метка>»
    await expect(page.getByText(kettle.title, { exact: true })).toBeVisible();

    await page.goto('/');
    await page.getByRole('link', { name: 'Телефоны' }).click();
    await expect(page.getByRole('link', { name: /Смартфон, 8\/256 ГБ/ })).toBeVisible();
    await expect(page.getByText(kettle.title, { exact: true })).toHaveCount(0);
    await expect(page.getByText('Снят с продажи')).toHaveCount(0);

    await page.getByRole('link', { name: /Смартфон, 8\/256 ГБ/ }).click();
    await expect(page.getByRole('heading', { name: 'Смартфон, 8/256 ГБ' })).toBeVisible();
    await expect(page.getByText('2 990 000 сум')).toBeVisible();
    await expect(page.getByText('Продавец: Магазин A')).toBeVisible();
  });

  test('3, 4, 6. гость собрал корзину, зарегистрировался, оплатил у двух продавцов; один заказ на двойное нажатие', async ({
    page,
  }) => {
    await addToCart(page, phone.productId);
    await addToCart(page, kettle.productId);
    await page.goto('/cart');
    await expect(page.getByTestId('cart-line')).toHaveCount(2);

    await page.getByRole('link', { name: 'Войдите, чтобы оформить заказ' }).click();
    await page.getByRole('link', { name: 'Зарегистрироваться' }).click();
    await register(page);

    // гостевая корзина объединена с серверной и удалена из браузера
    await page.waitForURL('**/checkout');
    await expect(page.getByText(phone.title)).toBeVisible();
    await expect(page.getByText(kettle.title)).toBeVisible();
    // строкой: в TS-конфиге e2e нет DOM-типов, код выполняется в браузере
    expect(await page.evaluate<string | null>(`window.localStorage.getItem('cart:v1')`)).toBeNull();

    await fillShipping(page);
    await page.getByRole('button', { name: /^Оплатить/ }).dblclick();
    await onPaymentPage(page);
    await page.getByRole('button', { name: 'Оплатить' }).click();

    // fake-psp вернул покупателя на страницу заказа витрины
    await page.waitForURL(/localhost:3001\/orders\//);
    orderUrl = page.url();
    await expect(status(page)).toHaveText('Заказ оформлен', { timeout: 60_000 });
    await expect(page.getByTestId('sub-order')).toHaveCount(2);
    await expect(page.getByText('Магазин A', { exact: true })).toBeVisible();
    await expect(page.getByText('Магазин B', { exact: true })).toBeVisible();

    await page.goto('/cart');
    await expect(page.getByText('Корзина пуста')).toBeVisible();
    await page.goto('/orders');
    // двойное нажатие «Оплатить» дало один заказ
    await expect(page.getByRole('link', { name: /Заказ .* Заказ оформлен/ })).toHaveCount(1);

    // оформление — один трейс, он начинается в storefront (SD-07, п. 1, сценарий 4)
    const services = (await (await fetch(`${JAEGER_URL}/api/services`)).json()) as {
      data: string[];
    };
    expect(services.data).toContain('storefront');
  });

  test('8. покупатель отменяет под-заказ до отгрузки: «Отменён», затем «Деньги возвращены»', async ({
    page,
  }) => {
    test.skip(!orderUrl, 'нужен заказ предыдущего сценария');
    page.on('dialog', (dialog) => void dialog.accept());
    await page.goto(orderUrl);
    const first = page.getByTestId('sub-order').first();
    await first.getByRole('button', { name: 'Отменить' }).click();
    await expect(first.getByText('Отменён', { exact: true })).toBeVisible();
    await expect(first.getByText('Деньги возвращены')).toBeVisible({ timeout: 90_000 });
    // второй под-заказ не изменился
    await expect(page.getByTestId('sub-order').nth(1).getByText('Собирается')).toBeVisible();
  });

  test('5. банк отклонил оплату — «Ожидает оплаты» и кнопка «Перейти к оплате»; вторая попытка проходит', async ({
    page,
  }) => {
    await page.goto('/register');
    await register(page);
    await page.waitForURL((url) => url.pathname === '/');
    await addToCart(page, kettle.productId);
    await page.goto('/checkout');
    await fillShipping(page);
    await page.getByRole('button', { name: /^Оплатить/ }).click();

    await onPaymentPage(page);
    await page.getByRole('button', { name: 'Отклонить' }).click();
    await expect(page.getByText('Отклонённых попыток: 1')).toBeVisible();
    await page.getByRole('link', { name: 'Вернуться в магазин' }).click();

    await page.waitForURL(/localhost:3001\/orders\//);
    await expect(status(page)).toHaveText('Ожидает оплаты');
    await page.getByRole('link', { name: 'Перейти к оплате' }).click();
    await onPaymentPage(page);
    await page.getByRole('button', { name: 'Оплатить' }).click();
    await page.waitForURL(/localhost:3001\/orders\//);
    await expect(status(page)).toHaveText('Заказ оформлен', { timeout: 60_000 });
  });

  test('10. сессия: токены только в HttpOnly cookie, выход завершает сессию', async ({
    page,
    context,
  }) => {
    await page.goto('/register');
    await register(page);
    await page.waitForURL((url) => url.pathname === '/');

    const cookies = await context.cookies();
    for (const name of ['sf_access', 'sf_refresh']) {
      expect(cookies.find((c) => c.name === name)).toMatchObject({
        httpOnly: true,
        sameSite: 'Lax',
      });
    }
    expect(await page.evaluate<string>('document.cookie')).not.toContain('sf_');
    const poll = await page.request.get('/bff/search?q=чайник');
    expect(await poll.text()).not.toContain('accessToken');

    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page.getByRole('link', { name: 'Войти' })).toBeVisible();
    expect((await context.cookies()).filter((c) => c.name.startsWith('sf_'))).toEqual([]);
    await page.goto('/orders');
    await page.waitForURL(
      (url) => url.pathname === '/login' && url.searchParams.get('next') === '/orders',
    );
  });
});
