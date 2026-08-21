import { AppServerManager } from "./app-server.js";
import { BridgeLifecycle, type BridgeShutdownKind } from "./bridge-lifecycle.js";
import { McpStdioServer } from "./mcp.js";
import { sanitizeForTransport } from "./runtime.js";
import { RuntimeStore } from "./runtime.js";
import { ControlSurface } from "./tools.js";
import { createUxProjectionFromEnvironment } from "./ux-projection.js";

const uxProjection = createUxProjectionFromEnvironment();
let lifecycle: BridgeLifecycle | undefined;
const appServer = new AppServerManager(new RuntimeStore(256, uxProjection), {
  onFatal: (error) => {
    reportFatal(error);
    requestShutdown(1, "app_server_fatal");
  },
});
const control = new ControlSurface(appServer);

let server: McpStdioServer;

function requestShutdown(exitCode: number, kind: BridgeShutdownKind): void {
  void lifecycle?.shutdown(exitCode, kind).catch((error: unknown) => {
    reportFatal(error);
    const currentExitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
    process.exitCode = Math.max(currentExitCode, 1);
  });
}

function reportFatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const safe = sanitizeForTransport(message, {
    maxStringChars: 4_000,
    totalCharBudget: 4_000,
  });
  process.stderr.write(`local-codex-bridge: ${String(safe)}\n`);
}

server = new McpStdioServer(control, {
  onClose: () => requestShutdown(0, "normal"),
  onError: (error) => {
    reportFatal(error);
    requestShutdown(1, "normal");
  },
});
lifecycle = new BridgeLifecycle(server, appServer);

process.once("SIGINT", () => requestShutdown(0, "normal"));
process.once("SIGTERM", () => requestShutdown(0, "normal"));
process.once("uncaughtException", (error) => {
  reportFatal(error);
  requestShutdown(1, "normal");
});
process.once("unhandledRejection", (error) => {
  reportFatal(error);
  requestShutdown(1, "normal");
});

server.start();
