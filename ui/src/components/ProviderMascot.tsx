import type { CSSProperties } from "react";
import { AgentCapability } from "../api";
import { Icon } from "./Icon";
import { OctoMark } from "./OctoMark";

export type ProviderMascotState = "ready" | "processing" | "disabled";

export function ProviderMascot({
  color,
  state,
  capability
}: {
  color: string;
  state: ProviderMascotState;
  capability: AgentCapability | null;
}) {
  const accessory = capabilityIcon(capability);
  return (
    <span className={`provider-mascot is-${state}`} style={{ "--mascot-color": color } as CSSProperties}>
      {state === "processing" ? <span className="provider-mascot-ring" aria-hidden="true" /> : null}
      <span className="provider-mascot-glyph"><OctoMark color={color} secondary={color} /></span>
      {accessory ? (
        <span className="provider-mascot-accessory" aria-hidden="true">
          <Icon name={accessory} />
        </span>
      ) : null}
    </span>
  );
}

export function capabilityIcon(capability: AgentCapability | null): string | null {
  if (!capability) return null;
  switch (capability) {
    case "planning": return "spark";
    case "coding": return "code";
    case "testing": return "pulse";
    case "reviewing":
    case "improvement_reviewing": return "shield";
    case "research": return "chat";
    case "conversation": return "hand";
  }
}
