import { useState } from "react";
import { NavLink } from "react-router-dom";
import { OctoMark } from "./OctoMark";
import { Icon } from "./Icon";

export interface SidebarProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function Sidebar({ collapsed: externalCollapsed, onToggleCollapse }: SidebarProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);

  const collapsed = externalCollapsed !== undefined ? externalCollapsed : internalCollapsed;
  const toggleCollapse = onToggleCollapse ?? (() => setInternalCollapsed(!internalCollapsed));

  const links = [
    { to: "/", label: "Visão geral", icon: "grid", end: true },
    { to: "/backlog", label: "Fluxo de tasks", icon: "pulse" },
    { to: "/reviews", label: "Aguardando revisão", icon: "hand" },
    { to: "/projects", label: "Projetos", icon: "folder" },
    { to: "/providers", label: "Providers", icon: "spark" },
    { to: "/analytics", label: "Analytics & Custo", icon: "timeline" },
    { to: "/settings", label: "Configurações", icon: "settings" }
  ];

  return (
    <aside className={`sidebar ${collapsed ? "is-collapsed" : ""}`}>
      <div className="sidebar-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <NavLink className="brand" to="/" aria-label="Octomynd Maestro">
          <OctoMark />
          {!collapsed && (
            <span>
              <strong>octo</strong>mynd<small>maestro</small>
            </span>
          )}
        </NavLink>
        <button
          className="sidebar-toggle-btn"
          onClick={toggleCollapse}
          aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
          title={collapsed ? "Expandir menu" : "Recolher menu"}
        >
          <Icon name={collapsed ? "chevronRight" : "chevronLeft"} />
        </button>
      </div>

      <nav aria-label="Navegação principal">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.end}
            className={({ isActive }) => (isActive ? "is-active" : "")}
            aria-label={link.label}
            title={collapsed ? link.label : undefined}
          >
            <Icon name={link.icon} />
            {!collapsed && <span>{link.label}</span>}
          </NavLink>
        ))}
      </nav>

      {!collapsed ? (
        <div className="sidebar-note">
          <span className="live-orb" />
          <div>
            <strong>Local-first</strong>
            <small>127.0.0.1 · acesso privado</small>
          </div>
        </div>
      ) : (
        <div className="sidebar-note collapsed-note" title="Local-first · 127.0.0.1">
          <span className="live-orb" />
        </div>
      )}
    </aside>
  );
}
