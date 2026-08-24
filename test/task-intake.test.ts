import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/db.js";
import { deriveTaskIntake, deriveTaskTitle } from "../src/tasks/intake.js";

describe("task intake metadata", () => {
  it("keeps a detailed user request while deriving a short title", () => {
    const request = "A ideia inicial é fazer um projeto que me ajude com o controle de finanças do apartamento e investimentos.";
    const intake = deriveTaskIntake(request);

    expect(intake.title.length).toBeLessThanOrEqual(82);
    expect(intake.title).not.toBe(request);
    expect(intake.title.toLowerCase()).toContain("criar");
    expect(intake.specification).toContain(request);
  });

  it("turns diagnostic wording into an actionable history title", () => {
    expect(deriveTaskTitle("dá uma olhada no login porque às vezes ele não funciona e tenta arrumar isso"))
      .toMatch(/^Revisar /);
  });

  it("does not depend on an LLM to produce metadata", () => {
    expect(deriveTaskTitle("Quero Criar um projeto de controle de finanças, organizar meu salario e as despesas etc"))
      .toMatch(/^Criar /);
  });

  it("persists title and specification while retaining the original request", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-intake-"));
    const database = createDatabase(path.join(root, "maestro.db"));
    try {
      database.registerProject({ key: "demo", name: "Demo", path: root, defaultBranch: "main" });
      const original = "Quero criar um projeto de controle de finanças e organizar as despesas.";
      const task = database.createTask(original, "test", "demo");
      expect(task.text).toBe(original);
      expect(task.title).toMatch(/^Criar /);
      expect(task.specification).toContain(original);
    } finally {
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
