# UI/UX improvements — Vitalix Android

## High-impact fixes (this pass)
- [x] **Edge-to-edge insets on 6 screens.** Added `applySystemBarsPadding()` (top+bottom systemBars) to `WindowInsets.kt`; called after `setContentView` in Login, Signup, Forgot, Onboarding, Settings, SyncLog. (Main/Update already handled insets.)
- [x] **Teal text contrast.** Added `vital_teal_text` (#0B7A73, ~4.6:1 on white); swapped all 9 `textColor="@color/vital_teal"` → `vital_teal_text` across forgot/insight/login/main/signup. `vital_teal` kept for fills.
- [x] Build to verify — `compileBetaDebugKotlin` BUILD SUCCESSFUL (resources merged, Kotlin clean; only a pre-existing FcmRegistrar deprecation warning).

## Deferred (done in roadmap Task 16)
- [x] Dark mode: `values-night/colors.xml` overrides the app palette (bg_app, bg_surface, text_primary/secondary, vital_teal_text #34C7BD, error/warning/success); night theme wires the Material surface/on-surface/container attrs. Contrast table in the Task 16 report.
- [x] Type/spacing scale: `dimens.xml` (space_4..32) and `styles_text.xml` (Vitalix.Title 20sp, Body 15sp, Caption 12sp); 11-16sp body sizes in layouts replaced, 24/28sp headings left as set.
- [x] Loading feedback: Sync now, Settings save and Forgot submit disable + inline spinner (`MaterialButton.setBusy`); backfill status reads "Reading <Month YYYY>…" from WorkManager progress.
- [x] Split `activity_main.xml` (39 KB to 2.4 KB) into `main_metrics`, `main_backfill`, `main_sync`, `main_sync_bar` includes; view ids unchanged (90 ids diffed identical). No auto-sync card exists on Main (it lives in Settings), so no `main_autosync`.

## Review
_(filled on completion)_
