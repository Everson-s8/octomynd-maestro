# Design QA — Providers / espécies dos presets

## Source visual truth

- User-provided preset source: `C:\Users\evers\Downloads\octomynd-polvos-preset.html`.
- User-provided Providers reference: `C:\Users\evers\AppData\Local\Temp\codex-clipboard-c24f0253-80e1-46bd-b3a1-4156ac68c905.png`.
- Product route: `http://127.0.0.1:4787/providers`.

## Implementation evidence

- Provider cards now render the preset species directly: Maestro for Planning, CRT for Implementation, Ciclope for Testing, Vampiro for Final review, Nautilus for Self-improvement, Anelado for Research, and Clássico for Conversation.
- A provider assigned to several capabilities displays the highest-priority capability using this order: Planning → Implementation → Testing → Final review → Self-improvement → Research → Conversation.
- Disabled providers render the exact Fantasma preset; processing providers render the same species with the occupied state and pulse ring.
- The page was checked in the Codex in-app browser at approximately 1608 × 935 CSS pixels.
- Browser console check: no errors or warnings reported.

## Interaction checks

- Paused Codex: the card changed to `polvo Fantasma`, `PAUSED`, with the dashed/muted treatment.
- Re-enabled Codex: the card returned to `polvo Maestro`, `PLANNING`.
- Restored Planning to Codex with `gpt-5.6-sol` and `Low`.
- Routing controls remain available for provider, model, effort, and fallback rule.

## Visual findings

- The Providers screen is repaginated into Cloud and Custom & local groups with a two-column card grid on wide screens and responsive single-column behavior when the routing panel needs room.
- Mascot motion is intentionally restrained: idle float, processing movement/pulse, and a static muted ghost when disabled.
- The warm Octomynd palette, serif hierarchy, mono metadata, border language, and orange interaction accents remain intact.
- Long routing values are ellipsized inside compact selects to keep all four controls visible; the native control still exposes the full option on open.

## Validation

- [x] Actual preset species are used instead of the generic logo.
- [x] Capability-to-species mapping is visible on provider cards.
- [x] Priority hierarchy is deterministic.
- [x] Fantasma disabled state verified in browser.
- [x] Processing animation path is implemented.
- [x] UI typecheck passed.
- [x] UI build passed.
- [x] Browser console is clean.

final result: passed
