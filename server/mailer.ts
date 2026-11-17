import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailMessage } from './emailTemplates.js';

export type MailMode = 'smtp' | 'console' | 'disabled';

/**
 * SMTP is used when SMTP_HOST is set. Without it, development prints emails to the
 * server log (so links can be copied), and production sends nothing.
 */
export function getMailMode(env: NodeJS.ProcessEnv = process.env): MailMode {
  if (env.SMTP_HOST) return 'smtp';
  return env.NODE_ENV === 'production' ? 'disabled' : 'console';
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

export function isEmailEnabled(): boolean {
  return getMailMode() !== 'disabled';
}

export async function sendEmail(to: string, message: EmailMessage): Promise<boolean> {
  const mode = getMailMode();
  if (mode === 'disabled') {
    console.warn(`Email not sent (SMTP is not configured): "${message.subject}"`);
    return false;
  }
  if (mode === 'console') {
    console.log(`\n--- Email (development; set SMTP_HOST to send for real) ---\nTo: ${to}\nSubject: ${message.subject}\n\n${message.text}\n--- End email ---\n`);
    return true;
  }
  await getTransporter().sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
  return true;
}

/** Sends without delaying the HTTP response; failures are logged, never thrown. */
export function sendEmailInBackground(to: string | null | undefined, message: EmailMessage): void {
  if (!to) return;
  void sendEmail(to, message).catch((error: unknown) => {
    console.error(`Email delivery failed for "${message.subject}":`, error);
  });
}
