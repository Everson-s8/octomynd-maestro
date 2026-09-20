import type { CSSProperties } from "react";
import { AgentCapability } from "../api";
import { Icon } from "./Icon";

export type ProviderMascotState = "ready" | "processing" | "disabled";
export type ProviderSpecies = "classico" | "dumbo" | "nautilus" | "vampiro" | "anelado" | "ciclope" | "crt" | "visor" | "maestro" | "fantasma";

const TINTA = "var(--tinta,#191310)";

const SPECIES_BY_CAPABILITY: Record<AgentCapability, ProviderSpecies> = {
  planning: "maestro",
  coding: "crt",
  testing: "ciclope",
  reviewing: "vampiro",
  improvement_reviewing: "nautilus",
  research: "anelado",
  conversation: "classico"
};

const SPECIES_LABEL: Record<ProviderSpecies, string> = {
  classico: "Clássico",
  dumbo: "Dumbo",
  nautilus: "Nautilus",
  vampiro: "Vampiro",
  anelado: "Anelado",
  ciclope: "Ciclope",
  crt: "CRT",
  visor: "Visor",
  maestro: "Maestro",
  fantasma: "Fantasma"
};

export function ProviderMascot({
  color,
  state,
  capability
}: {
  color: string;
  state: ProviderMascotState;
  capability: AgentCapability | null;
}) {
  const species = state === "disabled" ? "fantasma" : capability ? SPECIES_BY_CAPABILITY[capability] : "classico";
  const presetState = state === "disabled" ? "indisponivel" : state === "processing" ? "ocupado" : "ativo";
  const accessory = capabilityIcon(capability);
  const label = capability ? capabilityLabel(capability) : "Default";
  return (
    <span
      className={`provider-mascot is-${state}`}
      style={{ "--mascot-color": color, "--tinta": "#191310" } as CSSProperties}
      title={`${SPECIES_LABEL[species]} · ${label}`}
    >
      <span className="provider-mascot-sheen" aria-hidden="true" />
      <span className="provider-mascot-glyph" dangerouslySetInnerHTML={{ __html: svgDe(species, presetState, 48, "#191310") }} />
      {state === "processing" ? <span className="provider-mascot-ring" aria-hidden="true" /> : null}
      {accessory ? <span className="provider-mascot-accessory" aria-hidden="true"><Icon name={accessory} /></span> : null}
    </span>
  );
}

export function capabilityIcon(capability: AgentCapability | null): string | null {
  switch (capability) {
    case "planning": return "spark";
    case "coding": return "code";
    case "testing": return "pulse";
    case "reviewing":
    case "improvement_reviewing": return "shield";
    case "research": return "chat";
    case "conversation": return "hand";
    default: return null;
  }
}

function capabilityLabel(capability: AgentCapability): string {
  return {
    planning: "Planning",
    coding: "Implementation",
    testing: "Testing",
    reviewing: "Final review",
    improvement_reviewing: "Self-improvement",
    research: "Research",
    conversation: "Conversation"
  }[capability];
}

function olhos(cx1: number, cx2: number, cy: number, r: number, estado: string): string {
  if (estado === "indisponivel") {
    return `<path d="M${cx1 - r} ${cy}q${r} ${r * 0.9} ${r * 2} 0" fill="none" stroke="${TINTA}" stroke-width="${r * 0.62}" stroke-linecap="round"/><path d="M${cx2 - r} ${cy}q${r} ${r * 0.9} ${r * 2} 0" fill="none" stroke="${TINTA}" stroke-width="${r * 0.62}" stroke-linecap="round"/>`;
  }
  if (estado === "ocupado") {
    return `<rect x="${cx1 - r}" y="${cy - r * 0.42}" width="${r * 2}" height="${r * 0.84}" rx="${r * 0.42}" fill="${TINTA}"/><rect x="${cx2 - r}" y="${cy - r * 0.42}" width="${r * 2}" height="${r * 0.84}" rx="${r * 0.42}" fill="${TINTA}"/>`;
  }
  return `<ellipse cx="${cx1}" cy="${cy}" rx="${r}" ry="${r * 0.92}" fill="${TINTA}"/><ellipse cx="${cx2}" cy="${cy}" rx="${r}" ry="${r * 0.92}" fill="${TINTA}"/>`;
}

function bracos(esp: number, estilo: "caido" | "enrolado" | "espalhado"): string {
  const paths = estilo === "caido"
    ? ["M12 26.5C9.5 32 8 36 9.5 41.5", "M17 28C15.5 33.5 15 37.5 16 42.5", "M22 29C21.5 34.5 21.5 38.5 22 43.5", "M26 29C26.5 34.5 26.5 38.5 26 43.5", "M31 28C32.5 33.5 33 37.5 32 42.5", "M36 26.5C38.5 32 40 36 38.5 41.5"]
    : estilo === "enrolado"
      ? ["M12 26C7.5 31.5 4 35 5.6 39.8 6.6 42.8 10.2 42.4 10 39.4", "M17 28C14 33 12 37 13.6 41.6 14.4 43.8 17 43.4 17 41.4", "M21.6 29C20.8 34.5 20 38.5 21.4 43.4", "M26.4 29C27.2 34.5 28 38.5 26.6 43.4", "M31 28C34 33 36 37 34.4 41.6 33.6 43.8 31 43.4 31 41.4", "M36 26C40.5 31.5 44 35 42.4 39.8 41.4 42.8 37.8 42.4 38 39.4"]
      : ["M11 26C6 30 2.5 33.5 3.5 38.5", "M16 28C12 33 9 36.5 8.5 41.5", "M21 29C20 34.5 19 39 19.5 43.5", "M27 29C28 34.5 29 39 28.5 43.5", "M32 28C36 33 39 36.5 39.5 41.5", "M37 26C42 30 45.5 33.5 44.5 38.5"];
  return `<g fill="none" stroke="currentColor" stroke-width="${esp}" stroke-linecap="round">${paths.map((path) => `<path d="${path}"/>`).join("")}</g>`;
}

function ventosas(): string {
  return [[10.5, 33], [9.5, 37], [16, 34], [15.5, 38], [32, 34], [32.5, 38], [37.5, 33], [38.5, 37]]
    .map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="1" fill="${TINTA}" opacity=".55"/>`).join("");
}

const SPECIES: Record<ProviderSpecies, (estado: string) => string> = {
  classico: (estado) => bracos(3.2, "enrolado") + ventosas() + '<ellipse cx="24" cy="19" rx="13" ry="12.4" fill="currentColor"/>' + olhos(19.4, 28.6, 18.6, 3.3, estado),
  dumbo: (estado) => bracos(3, "caido") + '<path d="M11.5 14.5c-5-3.5-9-2.5-9.5 1 -.4 3.2 3.4 5.6 8 5.2z" fill="currentColor"/><path d="M36.5 14.5c5-3.5 9-2.5 9.5 1 .4 3.2-3.4 5.6-8 5.2z" fill="currentColor"/><ellipse cx="24" cy="20" rx="12.2" ry="11.6" fill="currentColor"/>' + olhos(19.6, 28.4, 19.4, 3.9, estado),
  nautilus: (estado) => '<g fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M31 33c-.5 4-1 7-3 10"/><path d="M35 33.5c.5 4 1.5 6.5 3.5 9.5"/><path d="M39 32c2.5 3 5 5 7 6.5"/><path d="M27.5 31.5c-2 3.5-4.5 5.5-7 6.5"/></g><circle cx="19" cy="20" r="14" fill="currentColor"></circle><g fill="none" stroke="' + TINTA + '" stroke-width="1.7" stroke-linecap="round" opacity=".72"><path d="M19 20C22.5 16.5 26 13.5 29.5 11.5"/><path d="M19 20C23 20 27.5 20.5 32.5 21.5"/><path d="M19 20C21 23.5 22.5 27 23.5 31.5"/><path d="M19 20C16 22.5 12.5 24 8 25"/><path d="M19 20C16.5 16 14 12.5 11 9.5"/><circle cx="19" cy="20" r="3.6"/></g><ellipse cx="34" cy="26.5" rx="7.4" ry="6.8" fill="currentColor"/>' + olhos(31.4, 36.8, 25.6, 2.4, estado),
  vampiro: (estado) => '<path d="M24 23 L3.5 41 C9.5 44 11.5 40.5 14.4 42.6 C17.3 44.7 19 41.2 21.4 43.2 C22.6 44.2 25.4 44.2 26.6 43.2 C29 41.2 30.7 44.7 33.6 42.6 C36.5 40.5 38.5 44 44.5 41 Z" fill="currentColor"/><g fill="none" stroke="' + TINTA + '" stroke-width="1.5" stroke-linecap="round" opacity=".55"><path d="M24 27 10.5 40"/><path d="M24 27 17.5 41.5"/><path d="M24 27v16"/><path d="M24 27 30.5 41.5"/><path d="M24 27 37.5 40"/></g><path d="M24 4.5c8.4 0 13.6 7 13.6 15 0 6.6-6.2 11-13.6 11s-13.6-4.4-13.6-11c0-8 5.2-15 13.6-15z" fill="currentColor"/>' + olhos(19.2, 28.8, 17.6, 3.6, estado),
  anelado: (estado) => bracos(2.4, "espalhado") + '<ellipse cx="24" cy="19.5" rx="12.6" ry="11.8" fill="currentColor"/><g fill="none" stroke="' + TINTA + '" stroke-width="1.5" opacity=".62"><circle cx="16" cy="12" r="2.4"/><circle cx="24" cy="9.6" r="2"/><circle cx="32" cy="12.4" r="2.4"/><circle cx="14.6" cy="24" r="2"/><circle cx="33.4" cy="24" r="2"/></g>' + olhos(19.6, 28.4, 18.8, 3.2, estado),
  ciclope: (estado) => bracos(3.4, "caido") + '<ellipse cx="24" cy="19" rx="13" ry="12.4" fill="currentColor"/>' + (estado === "indisponivel" ? '<path d="M17.5 20q6.5 5 13 0" fill="none" stroke="' + TINTA + '" stroke-width="3.2" stroke-linecap="round"/>' : estado === "ocupado" ? '<rect x="16.6" y="16.6" width="14.8" height="5" rx="2.5" fill="' + TINTA + '"/>' : '<circle cx="24" cy="19" r="7.4" fill="' + TINTA + '"/><circle cx="26.4" cy="16.6" r="2.2" fill="currentColor"/>'),
  crt: (estado) => '<g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M14 30c-3 4-6 6-6 10"/><path d="M20 31v11"/><path d="M28 31v11"/><path d="M34 30c3 4 6 6 6 10"/></g><g fill="currentColor"><rect x="5.6" y="38.4" width="4.8" height="4.8" rx="1.2"/><rect x="17.6" y="40" width="4.8" height="4.8" rx="1.2"/><rect x="25.6" y="40" width="4.8" height="4.8" rx="1.2"/><rect x="37.6" y="38.4" width="4.8" height="4.8" rx="1.2"/></g><path d="M22.5 5.5v4M25.5 5.5v4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><rect x="10.5" y="8.5" width="27" height="22.5" rx="6.5" fill="currentColor"/>' + (estado === "indisponivel" ? '<path d="M17 20h4M27 20h4" stroke="' + TINTA + '" stroke-width="2.6" stroke-linecap="round"/>' : olhos(19.4, 28.6, 19, 3.1, estado)) + '<g stroke="' + TINTA + '" stroke-width="1" opacity=".22"><path d="M12 13h24M12 17h24M12 21h24M12 25h24M12 29h24"/></g>',
  visor: (estado) => bracos(3.2, "espalhado") + '<path d="M24 6.4c7.6 0 13.4 5.4 13.4 12.6 0 6.6-6 11.4-13.4 11.4S10.6 25.6 10.6 19C10.6 11.8 16.4 6.4 24 6.4z" fill="currentColor"/>' + (estado === "indisponivel" ? '<rect x="11.4" y="16.6" width="25.2" height="5.6" rx="2.8" fill="' + TINTA + '" opacity=".45"/>' : '<rect x="11.4" y="15" width="25.2" height="8.4" rx="4.2" fill="' + TINTA + '"/>' + (estado === "ocupado" ? '<rect x="15" y="18.2" width="6" height="2" rx="1" fill="currentColor"/><rect x="27" y="18.2" width="6" height="2" rx="1" fill="currentColor"/>' : '<rect x="14.4" y="17" width="4.6" height="4.4" rx="2.2" fill="currentColor" opacity=".85"/>')),
  maestro: (estado) => bracos(3.2, "enrolado") + '<path d="M39 22 45 12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="45.2" cy="11.4" r="2" fill="currentColor"/><ellipse cx="24" cy="4.6" rx="9.4" ry="2.2" fill="none" stroke="currentColor" stroke-width="2"/><ellipse cx="24" cy="19.4" rx="13" ry="12.4" fill="currentColor"/><path d="M16.6 12.6l2.6-4.4 4.8 3.6 4.8-3.6 2.6 4.4" fill="none" stroke="' + TINTA + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".6"/>' + olhos(19.4, 28.6, 19, 3.3, estado),
  fantasma: () => '<path d="M24 5c8.2 0 13.6 6 13.6 14v20.6l-4.6-3.6-4.6 3.6-4.4-3.6-4.4 3.6-4.6-3.6-4.6 3.6V19C10.4 11 15.8 5 24 5z" fill="currentColor" opacity=".22"/><path d="M24 5c8.2 0 13.6 6 13.6 14v20.6l-4.6-3.6-4.6 3.6-4.4-3.6-4.4 3.6-4.6-3.6-4.6 3.6V19C10.4 11 15.8 5 24 5z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-dasharray="4 3.2" stroke-linejoin="round"/><ellipse cx="19.4" cy="18" rx="3.2" ry="3.6" fill="none" stroke="currentColor" stroke-width="2.2"/><ellipse cx="28.6" cy="18" rx="3.2" ry="3.6" fill="none" stroke="currentColor" stroke-width="2.2"/>',
};

function svgDe(tipo: ProviderSpecies, estado: string, tam: number, tinta: string): string {
  return `<svg viewBox="0 0 48 48" width="${tam}" height="${tam}" fill="none" style="--tinta:${tinta}" role="img" aria-label="polvo ${SPECIES_LABEL[tipo]}">${SPECIES[tipo](estado)}</svg>`;
}
