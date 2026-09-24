# Design QA — Providers / espécies dos presets

## Source visual truth

- User-provided preset source: `C:\Users\evers\Downloads\octomynd-polvos-preset.html`.
- Selected visual direction: `C:\Users\evers\.codex\generated_images\01a024c2-26ca-7002-900f-219a6365dd97\exec-66a6a984-4e63-4eab-acd2-67525283495d.png`.
- User-provided Providers reference: `C:\Users\evers\AppData\Local\Temp\codex-clipboard-c24f0253-80e1-46bd-b3a1-4156ac68c905.png`.
- Latest layout reference: `C:\Users\evers\AppData\Local\Temp\codex-clipboard-c69e15ea-52a7-45e8-9aab-ac04ef6f3d54.png`.
- Product route: `http://127.0.0.1:4787/providers`.

## Implementation evidence

- Provider cards render the actual preset species directly: Maestro for Planning, CRT for Implementation, Ciclope for Testing, Vampiro for Final review, Nautilus for Self-improvement, Anelado for Research, and Clássico for Conversation.
- Every routing capability now carries its own animated mascot, so all seven identities are visible even when the same provider owns several routes.
- A provider assigned to several capabilities displays the highest-priority capability using this order: Planning → Implementation → Testing → Final review → Self-improvement → Research → Conversation.
- Disabled providers render the exact Fantasma preset; processing providers render the same species with the occupied state and pulse ring.
- The page was checked in the Codex in-app browser at approximately 1600 × 935 CSS pixels.
- Browser console check: no errors or warnings reported.

## Interaction checks

- Paused Codex: the card changed to `polvo Fantasma`, `PAUSED`, with the dashed/muted treatment.
- Re-enabled Codex: the card returned to `polvo Maestro`, `PLANNING`.
- Restored Planning to Codex with `gpt-5.6-sol` and `Low`.
- Routing controls remain functional for provider, model, effort, and fallback rule.

## Visual findings

- The Providers screen now follows the latest reference composition: provider cards occupy the upper section, a full-width divider separates them from routing, and the function editor sits below.
- Routing is intentionally focused on one selected capability at a time, with the function selector, provider, model, effort, and fallback rule in one readable control card.
- The lower routing section preserves the reference hierarchy: descriptive function title on the left and the Control plane editor on the right.
- Mascot motion is restrained: idle float, processing movement/pulse, and a static muted ghost when disabled.
- The warm Octomynd palette, serif hierarchy, mono metadata, borders, orange interaction accents, and responsive stacking remain intact.

## Validation

- [x] Actual preset species are used instead of the generic logo.
- [x] Capability-specific mascot remains visible in the focused routing editor.
- [x] Function selector switches between all seven capabilities without duplicating a long table.
- [x] Capability-to-species mapping is deterministic.
- [x] Highest-priority representative logic is deterministic.
- [x] Fantasma disabled state verified in browser.
- [x] Planning `gpt-5.6-sol` / `Low` verified in browser.
- [x] Processing animation path is implemented.
- [x] UI typecheck passed.
- [x] UI build passed.
- [x] Browser console is clean.

final result: passed
