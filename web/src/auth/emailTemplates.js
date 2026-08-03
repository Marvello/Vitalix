import { config } from "../config.js";

function logoUrl() {
  return `${config.appBaseUrl}/logo.png`;
}

function layout(content) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vitalix</title></head>
<body style="margin:0;padding:0;background:#f0f4f7;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:#0E1B2B;-webkit-text-size-adjust:100%;">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f0f4f7;">
<tr><td style="padding:40px 16px;" align="center">

<table width="540" cellpadding="0" cellspacing="0" role="presentation" style="max-width:540px;width:100%;border-spacing:0;">

  <!-- Header -->
  <tr><td style="background:linear-gradient(135deg,#0FA9A0 0%,#34D399 100%);padding:36px 40px 32px;text-align:center;border-radius:16px 16px 0 0;">
    <img src="${logoUrl()}" width="56" height="56" alt="Vitalix" style="display:block;margin:0 auto 12px;border:0;border-radius:12px;">
    <span style="font-size:28px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;font-family:'Segoe UI',system-ui,sans-serif;">Vitalix</span>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:#ffffff;padding:40px 44px 44px;">
    ${content}
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#fafbfc;padding:24px 44px;border-top:1px solid #e8ecf0;border-radius:0 0 16px 16px;text-align:center;">
    <p style="margin:0;font-size:12px;color:#8e99a4;line-height:1.5;">Your vitals, your server.</p>
  </td></tr>

</table>

</td></tr>
</table>
</body></html>`;
}

function button(href, label) {
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:28px 0 4px;">
  <tr><td style="background:#0FA9A0;border-radius:8px;">
    <a href="${href}" target="_blank" style="display:inline-block;padding:14px 36px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;font-family:'Segoe UI',system-ui,sans-serif;">
      ${label} &rarr;
    </a>
  </td></tr></table>`;
}

function divider() {
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:28px 0;"><tr><td style="border-top:1px solid #e8ecf0;"></td></tr></table>`;
}

export function inviteEmail({ code, link, downloadUrl }) {
  const downloadBlock = downloadUrl
    ? `<p style="margin:16px 0 0;font-size:14px;color:#5a6570;">
        <a href="${downloadUrl}" style="color:#0FA9A0;font-weight:600;text-decoration:none;">Download the Vitalix app &darr;</a>
      </p>`
    : "";
  return {
    html: layout(`
      <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#0E1B2B;letter-spacing:-0.3px;">You're invited</h1>
      <p style="margin:0 0 0;font-size:15px;color:#5a6570;line-height:1.6;">
        Someone invited you to join Vitalix. Create your account to get started.
      </p>
      ${button(link, "Create your account")}
      ${divider()}
      <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#8e99a4;text-transform:uppercase;letter-spacing:0.8px;">Invite code</p>
      <table cellpadding="0" cellspacing="0" role="presentation"><tr>
        <td style="background:#f0fdfa;border:1px solid #d1fae5;border-radius:8px;padding:12px 20px;">
          <span style="font-family:'Courier New',monospace;font-size:22px;font-weight:700;letter-spacing:3px;color:#0d9488;">${code}</span>
        </td>
      </tr></table>
      ${downloadBlock}
      <p style="margin:28px 0 0;font-size:12px;color:#8e99a4;">This invite expires in 7 days.</p>
    `),
    text: `You're invited to Vitalix!\n\nYour invite code: ${code}\n\nSign up: ${link}\n${downloadUrl ? `\nDownload the app: ${downloadUrl}\n` : ""}\nExpires in 7 days.`,
  };
}

export function resetEmail({ link }) {
  return {
    html: layout(`
      <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#0E1B2B;letter-spacing:-0.3px;">Reset your password</h1>
      <p style="margin:0;font-size:15px;color:#5a6570;line-height:1.6;">
        We received a request to reset your password. Use the button below to choose a new one.
      </p>
      ${button(link, "Reset password")}
      <p style="margin:28px 0 0;font-size:12px;color:#8e99a4;">Didn't request this? Ignore this email — nothing will change.</p>
    `),
    text: `Reset your Vitalix password:\n\n${link}\n\nIf you didn't request this, ignore this email.`,
  };
}
