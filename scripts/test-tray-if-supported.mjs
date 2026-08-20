import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  process.stdout.write("Skipping optional Windows Tray tests on this platform.\n");
  process.exit(0);
}

const result = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "windows\\test-tray.ps1",
  ],
  { stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
