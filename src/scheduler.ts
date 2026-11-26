/**
 * Daily `run-due` through the Windows Task Scheduler.
 *
 * The PowerShell scripts are fixed: name, time and paths travel in environment
 * variables, so no character in a path can change what the script does.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

export const WINDOWS_TASK = "fattureincloud-mcp run-due";

/** StartWhenAvailable: a run missed with the PC off or asleep happens as soon as possible. */
export const WINDOWS_INSTALL = [
  "$ErrorActionPreference = 'Stop'",
  "$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $env:FIC_TASK_ARGUMENT",
  "$trigger = New-ScheduledTaskTrigger -Daily -At $env:FIC_TASK_TIME",
  "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
  "Register-ScheduledTask -TaskName $env:FIC_TASK_NAME -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null",
].join("; ");

export const WINDOWS_UNINSTALL = [
  "$ErrorActionPreference = 'Stop'",
  "if (Get-ScheduledTask -TaskName $env:FIC_TASK_NAME -ErrorAction SilentlyContinue) " +
    "{ Unregister-ScheduledTask -TaskName $env:FIC_TASK_NAME -Confirm:$false; 'removed' } else { 'missing' }",
].join("; ");

export interface WindowsTaskOptions {
  node: string;
  script: string;
  log: string;
  hour: number;
  minute: number;
}

export function windowsTaskEnv(o: WindowsTaskOptions) {
  return {
    FIC_TASK_NAME: WINDOWS_TASK,
    FIC_TASK_TIME: `${String(o.hour).padStart(2, "0")}:${String(o.minute).padStart(2, "0")}`,
    // cmd only to append the output to the log; /s strips the outer quotes
    FIC_TASK_ARGUMENT: `/d /s /c ""${o.node}" "${o.script}" run-due >> "${o.log}" 2>&1"`,
  };
}

function powershell(script: string, env: Record<string, string>): string {
  // full path: a powershell.exe in the current folder must not be picked up
  const exe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return execFileSync(exe, ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, ...env }, encoding: "utf8" });
}

export function installWindowsTask(o: WindowsTaskOptions): void {
  powershell(WINDOWS_INSTALL, windowsTaskEnv(o));
}

/** False when there was no task to remove. */
export function uninstallWindowsTask(): boolean {
  return powershell(WINDOWS_UNINSTALL, { FIC_TASK_NAME: WINDOWS_TASK }).trim() === "removed";
}
