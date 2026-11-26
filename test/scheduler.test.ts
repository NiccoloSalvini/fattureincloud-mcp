import { describe, expect, it } from "vitest";
import { WINDOWS_INSTALL, WINDOWS_UNINSTALL, windowsTaskEnv } from "../src/scheduler.js";

describe("Windows scheduled task", () => {
  const env = windowsTaskEnv({
    node: "C:\\Program Files\\nodejs\\node.exe",
    script: "C:\\Users\\Nicolò D'Angelo\\fatture in cloud\\dist\\index.js",
    log: "C:\\Users\\Nicolò D'Angelo\\.config\\fattureincloud-mcp\\run-due.log",
    hour: 8,
    minute: 5,
  });

  it("runs run-due and appends to the log, with every path quoted", () => {
    expect(env.FIC_TASK_TIME).toBe("08:05");
    expect(env.FIC_TASK_ARGUMENT).toBe(
      '/d /s /c ""C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Nicolò D\'Angelo\\fatture in cloud\\dist\\index.js" run-due ' +
        '>> "C:\\Users\\Nicolò D\'Angelo\\.config\\fattureincloud-mcp\\run-due.log" 2>&1"',
    );
  });

  it("keeps values out of the PowerShell scripts", () => {
    for (const script of [WINDOWS_INSTALL, WINDOWS_UNINSTALL]) {
      expect(script).not.toContain('"');
      expect(script).not.toContain("Angelo");
    }
    for (const name of Object.keys(env)) expect(WINDOWS_INSTALL).toContain(`$env:${name}`);
  });

  it("never stores the token in the task", () => {
    expect(Object.keys(env).sort()).toEqual(["FIC_TASK_ARGUMENT", "FIC_TASK_NAME", "FIC_TASK_TIME"]);
    expect(JSON.stringify(env)).not.toMatch(/ACCESS_TOKEN/);
  });
});
