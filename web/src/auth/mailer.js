import nodemailer from "nodemailer";
import { config } from "../config.js";

const transport = config.smtp
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  : null;

export async function sendMail(to, subject, { html, text }) {
  if (!transport) {
    console.log(`[mail:log] to=${to} subject=${subject}\n${text}`);
    return;
  }
  try {
    const info = await transport.sendMail({ from: config.mailFrom, to, subject, text, html });
    console.log(`[mail:sent] to=${to} messageId=${info.messageId}`);
  } catch (err) {
    console.error(`[mail:error] to=${to} subject=${subject}`, err.message);
    throw err;
  }
}
