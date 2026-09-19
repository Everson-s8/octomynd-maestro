# Internationalization and first-run onboarding

This document is the canonical engineering note for the dashboard language and first-run
experience. Product-facing guides remain in the public documentation site.

## Language model

Maestro keeps five language concerns separate:

1. **Code language** is English.
2. **Interface language** is persisted locally and currently supports `en` and `pt-BR`.
3. **User content language** is whatever the user writes in a task or chat.
4. **Model response language** follows the user's message where the chat contract permits it.
5. **Documentation language** is selected by the docs site (`/en/` or `/pt/`).

The interface is English-first. A browser configured for Portuguese is only a recommendation in
the first-run guide; it never silently changes an existing preference. `document.documentElement.lang`
is set before the first React render and again whenever the preference changes. All supported
locales are registered in `ui/src/i18n.tsx`, so adding a locale does not require duplicating a
selector's hardcoded options. The current UI is left-to-right.

Translation lookup treats English source strings as the canonical key. A missing Portuguese key
falls back to that English key instead of rendering an empty label. `translateCount` centralizes
singular/plural selection and `formatNumber` uses the active locale for numeric output.

## First-run flow

The dashboard shows a resumable setup card when `maestro:onboarding-completed` is absent:

1. Select interface language.
2. Understand what Maestro does and does not do.
3. Check whether an AI provider is ready and open provider setup when it is not.
4. Register a project or open a project-free Maestro chat.
5. Create the first task or open Chat.

The card can be skipped, stores the current step, and can be restarted from **Settings → First-run
onboarding**. It does not create a provider, grant permissions, alter a repository, or start a
task by itself. Those remain explicit user actions and existing governance gates still apply.

## Coverage and verification

The critical routes covered by the current implementation are the first-run card, Settings →
Language, Chat, Providers, Projects, Analytics, and the task flow. `test/i18n.test.ts` verifies the
locale registry, persistence, HTML metadata, recommendation-only browser detection, fallback,
pluralization, and locale-aware number formatting. `test/onboarding.test.ts` verifies resumable
state, invalid-state recovery, and reset behavior.

The operational chat already receives the selected interface locale separately from the user's
message, so changing the dashboard language does not rewrite or constrain project/task content.
Existing chat tests cover responses in languages that are not in the interface registry.

Known follow-ups are deliberately not hidden by this note: provider/CLI diagnostic strings still
originate in the runtime and need a separate structured-message catalog; some legacy deep views
contain untranslated copy; and the docs deployment must keep the English and Portuguese routes in
sync. These are tracked as polish work, not reasons to silently claim full translation parity.

## Accessibility and safety

The onboarding uses real headings, labelled controls, status semantics, keyboard-operable buttons,
and does not depend on color alone. Locale metadata is updated for assistive technology. Browser
storage failures degrade to an in-memory session without blocking the dashboard. No locale or
onboarding state contains credentials, repository paths, provider output, or task content.
