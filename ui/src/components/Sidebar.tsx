import { useState } from "react";
import { NavLink } from "react-router-dom";
import { OctoMark } from "./OctoMark";
import { Icon } from "./Icon";
import { translate } from "../i18n";

export interface SidebarProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function Sidebar({ collapsed: externalCollapsed, onToggleCollapse }: SidebarProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);

  const collapsed = externalCollapsed !== undefined ? externalCollapsed : internalCollapsed;
  const toggleCollapse = onToggleCollapse ?? (() => setInternalCollapsed(!internalCollapsed));

  const links = [
    { to: "/", label: translate("Overview"), icon: "grid", end: true },
    { to: "/backlog", label: translate("Task flow"), icon: "pulse" },
    { to: "/reviews", label: translate("Awaiting review"), icon: "hand" },
    { to: "/projects", label: translate("Projects"), icon: "folder" },
    { to: "/providers", label: translate("Providers"), icon: "spark" },
    { to: "/analytics", label: translate("Analytics & Usage"), icon: "timeline" },
    { to: "/settings", label: translate("Settings"), icon: "settings" }
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
          aria-label={collapsed ? translate("Expand menu") : translate("Collapse menu")}
          title={collapsed ? translate("Expand menu") : translate("Collapse menu")}
        >
          <Icon name={collapsed ? "chevronRight" : "chevronLeft"} />
        </button>
      </div>

      <nav aria-label={translate("Main navigation")}>
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
            <small>127.0.0.1 · {translate("private access")}</small>
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
