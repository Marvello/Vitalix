# Vitalix — Brand Guideline

A bridge that exports Google Fit data and forwards it to your own server. Privacy-first, self-hosted.

**Name meaning:** *Vitals* + `-ix`. Signals health data without claiming to be a Google product.
**Tagline options:** "Your vitals, your server." / "Fit data, forwarded."

---

## Logo

- **Motif:** a coral heart sitting behind a white ECG pulse, wrapped in `{ }` — health data as a structured payload.
- **Icon:** `vitalix-icon.svg` — full mark for app icon, avatars.
- **Favicon (≤32 px):** drop the braces, keep only the heart-pulse — the braces close up at small sizes.
- **Lockup:** `vitalix-lockup.svg` — icon + wordmark, for headers, docs, README.

**Rules**
- Clear space: keep empty space ≥ 25% of the icon's height on all sides.
- Min size: icon 32 px; lockup 120 px wide.
- On dark backgrounds, keep the gradient tile as-is (it holds contrast).
- Don't: recolor the pulse, stretch, add shadows, rotate, or place the gradient tile on a busy photo.

---

## Color

| Role | Hex | Use |
|------|-----|-----|
| Vital Teal (primary) | `#0FA9A0` | gradient start, primary buttons, links |
| Pulse Green (accent) | `#34D399` | gradient end, success/sync states |
| Heart Coral | `#FF6B81` | logo heart only; use sparingly as a health accent |
| Deep Ink | `#0E1B2B` | headings, body on light, dark bg |
| Slate | `#475569` | secondary text, borders |
| Cloud | `#F5F8FA` | app background |
| White | `#FFFFFF` | surfaces, pulse mark |

**Primary gradient:** linear 135°, `#0FA9A0 → #34D399`. Use sparingly — logo, hero, one key accent per screen.

---

## Typography

- **Display / logotype:** Space Grotesk, Bold — headings, wordmark.
- **UI / body:** Inter — all interface text.
- **Data / mono:** JetBrains Mono — timestamps, sync logs, payload/JSON views.

Scale (UI): 12 / 14 / 16 / 20 / 24 / 32 px. Body 16 px, line-height 1.5.

---

## Voice

Direct, technical, trustworthy. You're handing users control of their own data.
- Say: "Synced 1,240 records to your server."
- Avoid: hype, wellness fluff, emoji in system messages.
- Sync states: *Idle · Exporting · Sent · Failed (retry)*.

---

## App icon variants

- **Light stores:** gradient tile as provided.
- **Monochrome/notification:** white pulse mark on transparent.
- Export sizes: 1024, 512, 192, 180, 48, 32 px.
