import { describe, expect, it } from "vitest";
import path from "node:path";
import { loadConfig, validateRuntimeConfig } from "../src/config.js";

describe("config", () => {
  it("loads defaults without exposing a token", () => {
    const config = loadConfig(process.cwd(), {});

    expect(config.projectName).toBe("octomynd-maestro");
    expect(config.telegram.botToken).toBe("");
    expect(config.telegram.allowedUserId).toBeNull();
    expect(config.dashboard).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 4787
    });
    expect(config.autopilot).toEqual({
      enabled: true,
      pollIntervalMs: 30_000,
      maxConcurrentGoals: 1
    });
    expect(config.runtime).toEqual({
      tokenEfficient: true,
      codexInactivityTimeoutMs: 600_000,
      claudeInactivityTimeoutMs: 1_800_000,
      providerMaxRuntimeMs: undefined,
      goalDeadlineMs: undefined
    });
    expect(config.workGraph).toEqual({
      adoptionMode: "off"
    });
    expect(config.skills).toEqual({
      enabled: false,
      catalogPath: path.resolve("skills"),
      versionsPath: path.resolve(".maestro/skill-versions"),
      projectKey: "maestro"
    });
    expect(config.execution.expectedNodeVersion).toBe("20.17.0");
    expect(config.worktreesPath).toBe(config.execution.worktreesPath);
    if (process.platform === "win32") {
      expect(config.execution.rootPath).toBe(path.resolve("C:\\MaestroRuntime\\octomynd-maestro"));
    }
  });

  it("validates missing token", () => {
    const config = loadConfig(process.cwd(), {});

    expect(validateRuntimeConfig(config)).toContain("TELEGRAM_BOT_TOKEN is missing. Set it in .env.local.");
  });

  it("validates allowed user id", () => {
    const config = loadConfig(process.cwd(), {
      TELEGRAM_BOT_TOKEN: "configured",
      TELEGRAM_ALLOWED_USER_ID: "not-a-number"
    });

    expect(validateRuntimeConfig(config)).toContain("TELEGRAM_ALLOWED_USER_ID must contain only digits.");
  });

  it("keeps the dashboard bound to the local machine", () => {
    const config = loadConfig(process.cwd(), {
      TELEGRAM_BOT_TOKEN: "configured",
      MAESTRO_DASHBOARD_HOST: "0.0.0.0"
    });

    expect(validateRuntimeConfig(config)).toContain(
      "MAESTRO_DASHBOARD_HOST must stay local: use 127.0.0.1 or localhost."
    );
  });

  it("allows conservative autopilot tuning", () => {
    const config = loadConfig(process.cwd(), {
      MAESTRO_AUTOPILOT_ENABLED: "false",
      MAESTRO_AUTOPILOT_POLL_MS: "5000",
      MAESTRO_AUTOPILOT_MAX_CONCURRENT: "2"
    });

    expect(config.autopilot).toEqual({
      enabled: false,
      pollIntervalMs: 5_000,
      maxConcurrentGoals: 2
    });
  });

  it("allows disabling the token-efficient runtime adapter", () => {
    const config = loadConfig(process.cwd(), {
      MAESTRO_TOKEN_RUNTIME_ENABLED: "false"
    });

    expect(config.runtime.tokenEfficient).toBe(false);
  });

  it("configures Work Graph adoption behind a governed mode", () => {
    const config = loadConfig(process.cwd(), {
      MAESTRO_WORK_GRAPH_MODE: "shadow"
    });

    expect(config.workGraph.adoptionMode).toBe("shadow");
  });

  it("fails closed for invalid Work Graph adoption modes", () => {
    const env = {
      TELEGRAM_BOT_TOKEN: "configured",
      MAESTRO_WORK_GRAPH_MODE: "auto"
    };
    const config = loadConfig(process.cwd(), env);

    expect(config.workGraph.adoptionMode).toBe("off");
    expect(validateRuntimeConfig(config, env)).toContain(
      "MAESTRO_WORK_GRAPH_MODE must be one of: off, shadow, explicit."
    );
  });

  it("keeps governed Skills behind an explicit feature flag", () => {
    const config = loadConfig(process.cwd(), {
      MAESTRO_SKILLS_ENABLED: "true",
      MAESTRO_SKILLS_PROJECT_KEY: "OCTOMYND"
    });

    expect(config.skills.enabled).toBe(true);
    expect(config.skills.projectKey).toBe("octomynd");
  });

  it("blocks unsafe Windows execution roots before long-running work", () => {
    if (process.platform !== "win32") return;
    const config = loadConfig(process.cwd(), {
      TELEGRAM_BOT_TOKEN: "configured",
      USERPROFILE: "C:\\Users\\everson",
      MAESTRO_EXECUTION_ROOT: "C:\\Users\\everson\\OneDrive\\runtime"
    });

    const errors = validateRuntimeConfig(config, { USERPROFILE: "C:\\Users\\everson" });
    expect(errors).toContain("Execution roots must stay outside the user profile.");
    expect(errors).toContain("Execution roots must stay outside cloud-synced folders.");
  });

  it("accepts an explicit dedicated execution root", () => {
    const root = path.join(process.cwd(), "dedicated-runtime");
    const config = loadConfig(process.cwd(), {
      MAESTRO_EXECUTION_ROOT: root,
      MAESTRO_NODE_VERSION: "20.17.2"
    });

    expect(config.execution.rootPath).toBe(root);
    expect(config.worktreesPath).toBe(path.join(root, "worktrees"));
    expect(config.execution.expectedNodeVersion).toBe("20.17.2");
  });
});
