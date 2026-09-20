# Design QA — Providers / mascote de status

## Source visual truth

- Selected direction: Image Gen result 3, the restrained “mascot plus status overlay” direction.
- Reference image: `C:\Users\evers\.codex\generated_images\01a024c2-26ca-7002-900f-219a6365dd97\exec-66a6a984-4e63-4eab-acd2-67525283495d.png`
- Reference pixels: 1487 × 1058.
- Original Providers moodboard: `C:\Users\evers\AppData\Local\Temp\codex-clipboard-c24f0253-80e1-46bd-b3a1-4156ac68c905.png` (1470 × 685).

## Implementation evidence

- Route: `http://127.0.0.1:4787/providers`
- Browser-rendered capture: Codex In-app Browser tab 10, captured at 1606 × 935 CSS pixels.
- State: Providers loaded; Codex is primary for Planning with `gpt-5.6-sol` and `Low`; all visible providers enabled.
- Density normalization: no device scaling applied; comparison judged on composition and component regions because the selected mock and browser viewport have different aspect ratios.
- Console check: no browser errors or warnings reported by the browser console capture.

## Comparison

### Full view

The implementation preserves the selected direction's hierarchy: provider cards remain the operational surface, each card has a stable octopus avatar, role/status is expressed by a small chip and accessory, and the routing panel remains the primary control plane on the right. The existing Octomynd warm dark palette, serif headings, mono metadata, borders, and compact controls stay consistent with the source product.

### Focused regions

- Provider avatar: the existing Octomynd octopus is recolored per provider, receives a small capability icon when it is the primary route, and uses a pulse ring while the provider is working.
- Disabled/paused state: the mascot loses saturation and opacity, the avatar container becomes dashed, and the chip changes to a muted state label. This was exercised by pausing and re-enabling Codex.
- Planning routing: the rendered screen visibly shows Codex, `gpt-5.6-sol`, and `Low`, matching the selected direction.

## Findings

No actionable P0, P1, or P2 mismatches remain. The card layout is intentionally denser than the generated mock so it fits the existing Maestro routing panel and preserves the current product behavior. Individual provider species are intentionally not introduced in this pass; the selected direction called for a stable mascot with lightweight status overlays that scales better as providers grow.

## Comparison history

- Initial implementation: added the mascot, role chip, processing ring, and disabled treatment.
- Interaction pass: paused Codex and verified the ghost treatment; re-enabled it and restored Planning to Codex with `gpt-5.6-sol` / `Low`.
- Final pass: reloaded the page, captured the clean enabled state, ran UI typecheck/build, and checked browser logs.

## Implementation checklist

- [x] Stable octopus mascot in provider cards.
- [x] Capability accessory and role chip for the primary route.
- [x] Processing pulse ring.
- [x] Disabled/paused ghost treatment.
- [x] Existing provider toggle and routing controls remain functional.
- [x] UI typecheck passed.
- [x] UI build passed.
- [x] Browser interaction and console checks passed.

## Follow-up polish

- P3: consider adding a dedicated per-provider species preset later, once the state language is validated in real usage.

final result: passed
