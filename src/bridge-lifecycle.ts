import { FATAL_DRAIN_TIMEOUT_MS } from "./mcp.js";

export type BridgeShutdownKind = "normal" | "app_server_fatal";

export interface BridgeMcpLifecycle {
  close(): Promise<void>;
  closeAfterFatal(timeoutMs?: number): Promise<void>;
}

export interface BridgeAppServerLifecycle {
  close(): Promise<void>;
  runtime: {
    closeUxProjection(): void;
  };
}

export interface BridgeLifecycleOptions {
  fatalDrainTimeoutMs?: number;
  setExitCode?: (exitCode: number) => void;
}

export class BridgeLifecycle {
  readonly #server: BridgeMcpLifecycle;
  readonly #appServer: BridgeAppServerLifecycle;
  readonly #fatalDrainTimeoutMs: number;
  readonly #setExitCode: (exitCode: number) => void;

  #shutdownPromise: Promise<void> | null = null;
  #requestedExitCode = 0;

  constructor(
    server: BridgeMcpLifecycle,
    appServer: BridgeAppServerLifecycle,
    options: BridgeLifecycleOptions = {},
  ) {
    this.#server = server;
    this.#appServer = appServer;
    this.#fatalDrainTimeoutMs = options.fatalDrainTimeoutMs ?? FATAL_DRAIN_TIMEOUT_MS;
    this.#setExitCode = options.setExitCode ?? ((exitCode) => {
      const current = typeof process.exitCode === "number" ? process.exitCode : 0;
      process.exitCode = Math.max(current, exitCode);
    });
  }

  shutdown(exitCode: number, kind: BridgeShutdownKind): Promise<void> {
    this.#requestedExitCode = Math.max(this.#requestedExitCode, exitCode);
    this.#setExitCode(this.#requestedExitCode);
    if (!this.#shutdownPromise) {
      this.#shutdownPromise = this.#performShutdown(kind);
    }
    return this.#shutdownPromise;
  }

  async #performShutdown(kind: BridgeShutdownKind): Promise<void> {
    let failure: unknown;
    try {
      if (kind === "app_server_fatal") {
        await this.#server.closeAfterFatal(this.#fatalDrainTimeoutMs);
      } else {
        await this.#server.close();
      }
    } catch (error) {
      failure = error;
    }

    try {
      await this.#appServer.close();
    } catch (error) {
      failure ??= error;
    }

    try {
      this.#appServer.runtime.closeUxProjection();
    } catch (error) {
      failure ??= error;
    }

    if (failure !== undefined) {
      throw failure;
    }
  }
}
