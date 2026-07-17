import { describe, expect, it } from "vitest";
import { decideWorkGraphAdoption, isWorkGraphAdoptionMode, WORK_GRAPH_ADOPTION_MODES } from "../src/work-graphs/adoption.js";

describe("work graph adoption policy", () => {
  it("recognizes the governed set of adoption modes", () => {
    expect(WORK_GRAPH_ADOPTION_MODES).toEqual(["off", "shadow", "explicit"]);
    expect(isWorkGraphAdoptionMode("off")).toBe(true);
    expect(isWorkGraphAdoptionMode("shadow")).toBe(true);
    expect(isWorkGraphAdoptionMode("explicit")).toBe(true);
    expect(isWorkGraphAdoptionMode("auto")).toBe(false);
  });

  it("stays linear and records disabled_by_config when off", () => {
    const decision = decideWorkGraphAdoption({
      mode: "off",
      taskText: "refactor the migration schema and integrate the new database",
      projectKey: "maestro"
    });

    expect(decision).toMatchObject({
      mode: "off",
      decision: "off",
      reason: "disabled_by_config",
      executionMode: "linear",
      automaticFanOut: false
    });
    expect(decision.telemetry.candidate).toBe(true);
  });

  it("records a shadow decision without changing execution", () => {
    const decision = decideWorkGraphAdoption({
      mode: "shadow",
      taskText: "simple typo fix",
      projectKey: "maestro"
    });

    expect(decision).toMatchObject({
      mode: "shadow",
      decision: "shadow",
      reason: "shadow_mode_records_only",
      executionMode: "linear",
      automaticFanOut: false
    });
  });

  it("keeps explicit mode on the linear path when no explicit request is present", () => {
    const decision = decideWorkGraphAdoption({
      mode: "explicit",
      taskText: "add a small doc fix",
      projectKey: "maestro"
    });

    expect(decision).toMatchObject({
      mode: "explicit",
      decision: "off",
      reason: "explicit_request_required",
      executionMode: "linear",
      automaticFanOut: false
    });
  });

  it("records an explicit adoption request without executing automatic fan-out", () => {
    const decision = decideWorkGraphAdoption({
      mode: "explicit",
      taskText: "add a small doc fix",
      projectKey: "maestro",
      explicitRequest: true,
      trigger: "operator"
    });

    expect(decision).toMatchObject({
      mode: "explicit",
      decision: "explicit",
      reason: "explicit_request_recorded",
      executionMode: "linear",
      automaticFanOut: false
    });
    expect(decision.telemetry.trigger).toBe("operator");
  });

  it("never leaks raw task text in telemetry", () => {
    const taskText = "confidential migration plan for tenant acme with secret rollout steps";
    const decision = decideWorkGraphAdoption({
      mode: "shadow",
      taskText,
      projectKey: "maestro"
    });

    const serialized = JSON.stringify(decision.telemetry);
    expect(serialized).not.toContain(taskText);
    expect(decision.telemetry.taskTextLength).toBe(taskText.length);
  });
});
