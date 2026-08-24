import { useEffect, useState } from "react";
import { DashboardData, fetchProviderPolicy } from "../api";
import { agentStateLabel } from "../agentPresentation";
import { translate } from "../i18n";

type AgentId = DashboardData["agents"][number]["id"];

/** Provider identity colors (ink and nervous-system palette). */
const AGENT_COLORS: Partial<Record<AgentId, string>> = {
  codex: "#7c634a",
  claude: "#c4622d",
  antigravity: "#6f8f6a",
  telegram: "#5c6f8f",
};

const AGENT_LABEL: Partial<Record<AgentId, string>> = {
  codex: "Codex",
  claude: "Claude",
  antigravity: "Gemini",
  telegram: "Telegram",
};

/** Arm directions distributed around the core. */
const ARMS = [
  { bx: 0.42, by: -0.05 },
  { bx: 0.75, by: 0.18 },
  { bx: 0.8, by: 0.62 },
  { bx: 0.5, by: 0.92 },
  { bx: 0.16, by: 0.78 },
  { bx: 0.08, by: 0.32 },
];

interface NervousSystemProps {
  agents: DashboardData["agents"];
}

/**
 * Organic diagram: core = Maestro, one arm per active provider.
 * Arm width/color reflect real activity. Each arm ends at a point with a label and state.
 */
export function NervousSystem({ agents }: NervousSystemProps) {
  // Only show connected providers: hide any paused/disabled (mode !== "enabled").
  const [modeByProvider, setModeByProvider] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    fetchProviderPolicy()
      .then((policy) => {
        if (!active) return;
        const m: Record<string, string> = {};
        policy.controls.forEach((c) => (m[c.providerId] = c.mode));
        setModeByProvider(m);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const tips = agents
    .filter(
      (agent) =>
        agent.id !== "telegram" &&
        agent.id !== "codex" ||
        agent.id === "codex"
    )
    .filter((agent) => (modeByProvider[agent.id] ?? "enabled") === "enabled")
    .slice(0, ARMS.length);

  return (
    <svg viewBox="0 0 560 340" role="img" aria-label={translate("Active Maestro providers")} className="nervous-system">
      {/* núcleo = Maestro */}
      <g className="core-breath">
        <ellipse cx="150" cy="175" rx="32" ry="29" fill="#c4622d" />
        <ellipse cx="150" cy="175" rx="32" ry="29" fill="none" stroke="#e8967a" strokeWidth="1" opacity="0.35" />
      </g>

      {tips.map((agent, i) => {
        const arm = ARMS[i % ARMS.length];
        const color = AGENT_COLORS[agent.id] ?? "#8a7c68";
        const working = agent.state === "working";
        const ex = 150 + arm.bx * 330;
        const ey = 175 + arm.by * 120;
        const label = AGENT_LABEL[agent.id] ?? agent.label;
        return (
          <g key={agent.id}>
            <path
              className={working ? "iv-arm working" : "iv-arm"}
              d={`M176 168 C ${ex * 0.55 + 90} ${ey * 0.55 + 60}, ${ex * 0.8} ${ey * 0.82}, ${ex} ${ey}`}
              stroke={color}
              strokeWidth={working ? 9 : 3.5}
              strokeLinecap="round"
              fill="none"
              opacity={working ? 1 : 0.5}
            />
            <circle cx={ex} cy={ey} r={working ? 6 : 4} fill={color} />
            <text x={ex + 10} y={ey - 4} fill={working ? color : "#8a7c68"} className="arm-label">
              {label}
            </text>
            <text x={ex + 10} y={ey + 12} fill="#8a7c68" className="arm-label arm-sub">
              {translate(agentStateLabel(agent.state))}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
