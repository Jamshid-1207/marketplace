import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { CONFIG, type Config } from '../config';
import { Mailer } from '../handlers/delivery';

/** SMTP через nodemailer; локально и в e2e — Mailpit (ТЗ, 3.7). */
@Injectable()
export class SmtpMailer extends Mailer implements OnApplicationShutdown {
  private readonly transport: Transporter;

  constructor(@Inject(CONFIG) private readonly config: Config) {
    super();
    this.transport = createTransport(config.SMTP_URL);
  }

  async send(mail: {
    to: string;
    subject: string;
    text: string;
    messageId: string;
  }): Promise<void> {
    await this.transport.sendMail({ from: this.config.NOTIFY_FROM, ...mail });
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}
