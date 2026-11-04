# UI/UX improvements — Vitalix Android

## High-impact fixes (this pass)
- [x] **Edge-to-edge insets on 6 screens.** Added `applySystemBarsPadding()` (top+bottom systemBars) to `WindowInsets.kt`; called after `setContentView` in Login, Signup, Forgot, Onboarding, Settings, SyncLog. (Main/Update already handled insets.)
- [x] **Teal text contrast.** Added `vital_teal_text` (#0B7A73, 5.2:1 on white, 4.9:1 on the light surface); swapped all 9 `textColor="@color/vital_teal"` → `vital_teal_text` across forgot/insight/login/main/signup. `vital_teal` kept for fills.
- [x] **Dialog buttons.** `materialAlertDialogTheme`/`alertDialogTheme` overlays (both themes) route `buttonBar{Positive,Negative,Neutral}ButtonStyle` to `Widget.Vitalix.Button.TextButton`; dialog buttons now #0B7A73 light / #34C7BD night. "Delete permanently" stays `colorError` (set in code after `show()`).
- [x] Build to verify — `compileBetaDebugKotlin` BUILD SUCCESSFUL (resources merged, Kotlin clean; only a pre-existing FcmRegistrar deprecation warning).

## Deferred (done in roadmap Task 16)
- [x] Dark mode: `values-night/colors.xml` overrides the app palette (bg_app, bg_surface, text_primary/secondary, vital_teal_text #34C7BD, error/warning/success); night theme wires the Material surface/on-surface/container attrs. Contrast table in the Task 16 report.
- [x] Type/spacing scale: `dimens.xml` (space_4..32) and `styles_text.xml` (Vitalix.Title 20sp, Body 15sp, Caption 12sp); 11-16sp body sizes in layouts replaced, 24/28sp headings left as set.
- [x] Loading feedback: Sync now, Settings save and Forgot submit disable + inline spinner (`MaterialButton.setBusy`); backfill status reads "Reading <Month YYYY>…" from WorkManager progress.
- [x] Split `activity_main.xml` (39 KB to 2.4 KB) into `main_metrics`, `main_backfill`, `main_sync`, `main_sync_bar` includes; view ids unchanged (90 ids diffed identical). No auto-sync card exists on Main (it lives in Settings), so no `main_autosync`.

## Contrast table (WCAG 2.x, recomputed)
Light surface is `#FFFEF7FF` (bg_app = bg_surface), not `#FFFFFF`. Night: bg_app `#0F1417`, bg_surface `#172024`. Needs 4.5:1 for text.

| Pair | Light | Night (app / surface) |
|------|-------|-----------------------|
| text_primary | 16.2 | 15.8 / 14.1 |
| text_secondary | 8.9 | 8.5 / 7.6 |
| vital_teal_text (#0B7A73 light, #34C7BD night) | 4.9 | 8.9 / 7.9 |
| error_red | 6.2 | 6.7 / 6.0 |
| warning_amber | 4.8 | 8.6 / 7.7 |
| success_green | 6.8 | 10.6 / 9.5 |
| White on button_primary #0B7A73 (primary buttons) | 5.2 | 5.2 (same fill) |
| colorPrimary #0FA9A0 as text on light (old outlined/text buttons, links) | 2.9, fails (now vital_teal_text) | n/a |
| Outlined/text button text + stroke (new, vital_teal_text) | 4.9 | 8.9 / 7.9 |
| White on vital_teal #0FA9A0 (old button fill) | 2.9, fails | 2.9, fails |
| deep_ink on vital_teal (widget chip) | 6.0, passes, unchanged | 6.0 |
| slate (old SyncLog RUNNING) | 4.5 | 3.9 / 3.5, fails |
| text_secondary (new SyncLog RUNNING) | 8.9 | 8.5 / 7.6 |

## Review
_(filled on completion)_
