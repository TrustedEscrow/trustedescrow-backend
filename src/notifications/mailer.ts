import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Email carries notifications and verification links only. Delivery codes are never
 * sent by email or SMS (ARCHITECTURE §6); the backend doesn't have them to send.
 */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class ConsoleMailer implements Mailer {
  constructor(private readonly log: (msg: string) => void = console.log) {}

  async send(m: MailMessage): Promise<void> {
    this.log(`[mail] to=${m.to} subject=${JSON.stringify(m.subject)}\n${m.text}`);
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(m: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text });
  }
}

export function createMailer(config: Config): Mailer {
  if (config.EMAIL_DRIVER === 'smtp') {
    if (!config.SMTP_URL) throw new Error('EMAIL_DRIVER=smtp requires SMTP_URL');
    return new SmtpMailer(config.SMTP_URL, config.EMAIL_FROM);
  }
  return new ConsoleMailer();
}
