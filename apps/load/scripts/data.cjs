// Данные для k6 (SD-09, п. 3): демо-каталог, склады и тестовые пользователи — из контрактов,
// как у e2e. k6 не читает TypeScript и пакеты npm, поэтому получает их файлом JSON.
const { DEV_CATALOG, DEV_STOCK, DEV_WAREHOUSES, devUser } = require('@repo/contracts');

const skus = DEV_CATALOG.filter((sku) => sku.active).map((sku) => {
  const stocked = DEV_STOCK.find((row) => row.skuId === sku.skuId);
  return {
    skuId: sku.skuId,
    productId: sku.productId,
    sellerId: sku.sellerId,
    title: sku.title,
    warehouseId: stocked?.warehouseId ?? null,
  };
});

process.stdout.write(
  `${JSON.stringify(
    {
      skus: skus.filter((sku) => sku.warehouseId),
      sellers: ['seller-a', 'seller-b'].map((login) => {
        const user = devUser(login);
        return { login, email: user.email, sellerId: user.sellerId };
      }),
      admin: devUser('admin').email,
      warehouses: DEV_WAREHOUSES.map(({ warehouseId, sellerId }) => ({ warehouseId, sellerId })),
    },
    null,
    2,
  )}\n`,
);
