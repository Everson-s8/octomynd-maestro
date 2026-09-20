# Design QA — Providers / espécies dos presets

## Source visual truth

- User-provided preset source: `C:\Users\evers\Downloads\octomynd-polvos-preset.html`.
- Selected visual direction: `C:\Users\evers\.codex\generated_images\01a024c2-26ca-7002-900f-219a6365dd97\exec-66a6a984-4e63-4eab-acd2-67525283495d.png`.
- User-provided Providers reference: `C:\Users\evers\AppData\Local\Temp\codex-clipboard-c24f0253-80e1-46bd-b3a1-4156ac68c905.png`.
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

- The Providers screen now follows the selected direction more closely: three provider cards across the cloud grid, clear role chips/descriptions, and a dedicated Control plane beside them.
- Each routing row uses a two-line control layout so provider/model remain readable while effort and fallback stay visible.
- Mascot motion is restrained: idle float, processing movement/pulse, and a static muted ghost when disabled.
- The warm Octomynd palette, serif hierarchy, mono metadata, borders, orange interaction accents, and responsive stacking remain intact.

## Validation

- [x] Actual preset species are used instead of the generic logo.
- [x] All seven capability mascots are visible in the routing panel.
- [x] Capability-to-species mapping is deterministic.
- [x] Highest-priority representative logic is deterministic.
- [x] Fantasma disabled state verified in browser.
- [x] Planning `gpt-5.6-sol` / `Low` verified in browser.
- [x] Processing animation path is implemented.
- [x] UI typecheck passed.
- [x] UI build passed.
- [x] Browser console is clean.

final result: passed
