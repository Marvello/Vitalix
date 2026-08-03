const ICON_SVG = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="vx-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0FA9A0"/><stop offset="1" stop-color="#34D399"/></linearGradient></defs>
<rect x="0" y="0" width="512" height="512" rx="112" fill="url(#vx-bg)"/>
<path d="M 259.496 393.765 C 221.107 334.99 134.731 313.399 134.731 236.632 C 134.731 191.052 169.521 165.863 207.91 165.863 C 231.904 165.863 249.898 182.655 259.496 197.049 C 269.093 182.655 287.088 165.863 311.081 165.863 C 349.47 165.863 384.26 191.052 384.26 236.632 C 384.26 313.399 297.885 334.99 259.496 393.765 Z" fill="#FF6B81"/>
<g fill="none" stroke="#FFFFFF" stroke-linecap="round" stroke-linejoin="round">
<path stroke-width="16" d="M 119.74 210.013 C 109.388 213.248 109.388 224.247 109.388 238.48 C 109.388 255.302 102.919 264.359 96.449 274.711 C 102.919 285.063 109.388 294.12 109.388 310.942 C 109.388 325.175 109.388 336.174 119.74 339.409"/>
<path stroke-width="16" d="M 398.278 210.149 C 408.683 213.4 408.683 224.455 408.683 238.76 C 408.683 255.667 415.185 264.77 421.687 275.174 C 415.185 285.577 408.683 294.681 408.683 311.588 C 408.683 325.893 408.683 336.947 398.278 340.199"/>
<path stroke-width="28" d="M 168.584 275.195 L 206.584 275.195 L 218.584 303.195 L 248.584 179.195 L 278.584 371.195 L 292.584 275.195 L 328.584 275.195"/>
</g></svg>`;

const ICON_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(ICON_SVG).toString("base64")}`;

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
    <img src="${ICON_DATA_URI}" width="56" height="56" alt="Vitalix" style="display:block;margin:0 auto 12px;border:0;border-radius:12px;">
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
