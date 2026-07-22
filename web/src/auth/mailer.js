import nodemailer from "nodemailer";
import { config } from "../config.js";

const transport = config.smtp
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  : null;

export async function sendMail(to, subject, body) {
  if (!transport) {
    console.log(`[mail:log] to=${to} subject=${subject}\n${body}`);
    return;
  }
  await transport.sendMail({ from: config.mailFrom, to, subject, text: body });
}
