import { DashboardData } from "../api";
import { agentStateLabel } from "../agentPresentation";

type AgentId = DashboardData["agents"][number]["id"];

/** Cores de identificação por provider (paleta tinta & sistema nervoso). */
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

/** Direções dos braços, espalhadas ao redor do núcleo. */
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
 * Diagrama orgânico: núcleo = Maestro, um braço por provider ativo.
 * Espessura/cor do braço = atividade real (grosso + pigmentado = processando agora;
 * fino + acinzentado = ocioso/pronto). Cada braço termina num ponto com label + estado.
 */
export function NervousSystem({ agents }: NervousSystemProps) {
  const tips = agents
    .filter((agent) => agent.id !== "telegram" && agent.id !== "codex" || agent.id === "codex")
    .slice(0, ARMS.length);

  return (
    <svg viewBox="0 0 560 340" role="img" aria-label="Providers ativos do Maestro" className="nervous-system">
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
              {agentStateLabel(agent.state)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
