import { Module } from '@nestjs/common';
import { Delivery, Mailer } from './handlers/delivery';
import { EventsHandler } from './handlers/events.handler';
import { SmtpMailer } from './infrastructure/smtp.mailer';
import { NotificationsRepository } from './repositories/notifications.repository';

/** Письма по событиям (SD-06, п. 6). */
@Module({
  providers: [
    NotificationsRepository,
    EventsHandler,
    Delivery,
    { provide: Mailer, useClass: SmtpMailer },
  ],
  exports: [Delivery],
})
export class NotificationModule {}
