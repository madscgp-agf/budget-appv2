import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { recordIntegrationError } from './integrationErrors.js';

let transport = null;
const outbox = []; // demo/test only: last messages, so tests and the demo UI can read the link

export const mailConfigured = () => Boolean(config.mail.smtpUrl);

function getTransport() {
  if (!transport && config.mail.smtpUrl) transport = nodemailer.createTransport(config.mail.smtpUrl);
  return transport;
}

export function lastMessages() {
  return outbox;
}

export async function sendMagicLink(to, link, minutes) {
  const subject = 'Gem din Oversized Bench-rekord';
  const text = [
    'Hej!',
    '',
    `Åbn linket herunder for at knytte din Oversized Bench-profil til denne e-mail.`,
    `Linket virker én gang og udløber om ${minutes} minutter.`,
    '',
    link,
    '',
    'Har du ikke bedt om det, kan du bare ignorere mailen.',
    '– Oversized Studios',
  ].join('\n');

  const t = getTransport();
  if (!t) {
    // DEMO: no SMTP configured. The link is logged and kept in memory only.
    outbox.push({ to, subject, text, link, at: new Date().toISOString() });
    if (outbox.length > 20) outbox.shift();
    if (process.env.NODE_ENV !== 'test') console.log(`[demo mail] to ${to}: ${link}`);
    return { delivered: false, demo: true };
  }
  try {
    await t.sendMail({ from: config.mail.from, to, subject, text });
    return { delivered: true };
  } catch (err) {
    recordIntegrationError('mail', err.message);
    throw err;
  }
}
