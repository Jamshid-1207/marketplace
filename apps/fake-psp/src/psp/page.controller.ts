import { Controller, Get, Header, NotFoundException, Param, Post, Redirect } from '@nestjs/common';
import { PspStore, type PspPayment } from './psp-store';

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const formatSum = (minor: number) =>
  `${(minor / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 })} сум`;

const STATUS_TEXT: Record<PspPayment['status'], string> = {
  requires_action: 'Ожидает оплаты',
  authorized: 'Оплачено: деньги заблокированы',
  captured: 'Оплачено и списано',
  voided: 'Платёж отменён',
  expired: 'Срок оплаты истёк',
};

/**
 * Страница оплаты провайдера (SD-02, п. 3.2): сюда storefront перенаправляет покупателя.
 * «Отклонить» изображает отказ банка: платёж остаётся неоплаченным, можно попробовать снова.
 */
@Controller('pay')
export class PageController {
  constructor(private readonly store: PspStore) {}

  @Get(':id')
  @Header('content-type', 'text/html; charset=utf-8')
  page(@Param('id') id: string): string {
    const payment = this.find(id);
    const actions =
      payment.status === 'requires_action'
        ? `<form method="post" action="/pay/${escape(id)}/authorize"><button>Оплатить</button></form>
           <form method="post" action="/pay/${escape(id)}/decline"><button>Отклонить</button></form>`
        : '';
    const declined = payment.declines > 0 ? `<p>Отклонённых попыток: ${payment.declines}</p>` : '';
    return `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>fake-psp: оплата</title></head>
<body>
  <h1>Оплата заказа</h1>
  <p>Сумма: <b>${formatSum(payment.amountMinor)}</b></p>
  <p>Статус: ${STATUS_TEXT[payment.status]}</p>
  ${declined}
  ${actions}
</body>
</html>`;
  }

  @Post(':id/authorize')
  @Redirect()
  authorize(@Param('id') id: string) {
    this.find(id);
    this.store.authorize(id);
    return { url: `/pay/${id}`, statusCode: 303 };
  }

  @Post(':id/decline')
  @Redirect()
  decline(@Param('id') id: string) {
    this.find(id);
    this.store.decline(id);
    return { url: `/pay/${id}`, statusCode: 303 };
  }

  private find(id: string): PspPayment {
    const payment = this.store.get(id);
    if (!payment) throw new NotFoundException();
    return payment;
  }
}
