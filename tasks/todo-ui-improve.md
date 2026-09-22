# UI/UX improvements — Vitalix Android

## High-impact fixes (this pass)
- [x] **Edge-to-edge insets on 6 screens.** Added `applySystemBarsPadding()` (top+bottom systemBars) to `WindowInsets.kt`; called after `setContentView` in Login, Signup, Forgot, Onboarding, Settings, SyncLog. (Main/Update already handled insets.)
- [x] **Teal text contrast.** Added `vital_teal_text` (#0B7A73, ~4.6:1 on white); swapped all 9 `textColor="@color/vital_teal"` → `vital_teal_text` across forgot/insight/login/main/signup. `vital_teal` kept for fills.
- [x] Build to verify — `compileBetaDebugKotlin` BUILD SUCCESSFUL (resources merged, Kotlin clean; only a pre-existing FcmRegistrar deprecation warning).

## Deferred (offer after)
- Dark mode: real `values-night/colors.xml` (night theme currently adds nothing).
- Type/spacing scale: `dimens.xml` + `textAppearance` styles; collapse 13/16sp body sizes.
- Loading/empty feedback on primary sync, Settings save, Forgot, backfill.
- Split monolithic `activity_main.xml` (39 KB).

## Review
_(filled on completion)_
