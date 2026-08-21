import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  APP_SERVER_ENV_PASSTHROUGH,
  APP_SERVER_HARD_DENY_ENV_NAMES,
  buildAppServerEnv,
  parseAppServerEnvPassthrough,
} from "../src/app-server-env.js";
import {
  AppServerFatalError,
  AppServerManager,
  AppServerShutdownError,
  createSerializedWriter,
  writeWithBackpressure,
  type AppServerChild,
} from "../src/app-server.js";
import { BridgeLifecycle } from "../src/bridge-lifecycle.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";

const fakeCodex = fileURLToPath(new URL("../../test/fake-codex.mjs", import.meta.url));
const timeoutCodex = fileURLToPath(new URL("../../test/timeout-codex.mjs", import.meta.url));
const pendingWriteCodex = fileURLToPath(new URL("../../test/pending-write-codex.mjs", import.meta.url));
const lateResponseCodex = fileURLToPath(new URL("../../test/late-response-codex.mjs", import.meta.url));
const duplicateRequestCodex = fileURLToPath(new URL("../../test/duplicate-request-codex.mjs", import.meta.url));
const initializeFailureCodex = fileURLToPath(new URL("../../test/initialize-failure-codex.mjs", import.meta.url));
const pendingInitializeCodex = fileURLToPath(new URL("../../test/pending-initialize-codex.mjs", import.meta.url));
const TEST_CWD = process.platform === "win32" ? "D:\\Bridge" : "/Bridge";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(filePath: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${filePath}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCondition(
  condition: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await delay(1);
  }
}

class RejectingResponseManager extends AppServerManager {
  lastResponseId: string | number | undefined;

  override async respond(id: string | number, _result: unknown): Promise<void> {
    this.lastResponseId = id;
    throw new Error("synthetic app-server response write failure");
  }
}

class ControlledBackpressureSink extends EventEmitter {
  writable = true;
  writableEnded = false;
  destroyed = false;
  readonly chunks: string[] = [];
  #callback: ((error?: Error | null) => void) | null = null;

  write(
    chunk: string,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): boolean {
    this.chunks.push(chunk);
    this.#callback = callback;
    return false;
  }

  completeWrite(error?: Error): void {
    const callback = this.#callback;
    if (!callback) {
      throw new Error("No controlled write is pending");
    }
    this.#callback = null;
    callback(error);
  }
}

class ControlledAppServerChild extends EventEmitter implements AppServerChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number | undefined = 42;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly receivedMethods: string[] = [];
  initialized = false;
  exitEvents = 0;
  killCalls = 0;

  #stdinBuffer = "";
  #exited = false;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.#onStdin(chunk));
    this.stdin.once("finish", () => {
      if (this.exitCode !== null || this.signalCode !== null) {
        this.emitExit(this.exitCode, this.signalCode);
      } else {
        this.emitExit(0, null);
      }
    });
    queueMicrotask(() => this.emit("spawn"));
  }

  async closeStdout(): Promise<void> {
    if (this.stdout.destroyed) {
      return;
    }
    const closed = new Promise<void>((resolve) => this.stdout.once("close", resolve));
    this.stdout.destroy();
    await closed;
  }

  setExitState(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exited) {
      return;
    }
    this.#exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.exitEvents += 1;
    this.emit("exit", code, signal);
    this.stdout.destroy();
    this.stderr.destroy();
  }

  kill(): boolean {
    this.killCalls += 1;
    this.emitExit(null, "SIGTERM");
    return true;
  }

  #onStdin(chunk: Buffer): void {
    this.#stdinBuffer += chunk.toString("utf8");
    while (true) {
      const newline = this.#stdinBuffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.#stdinBuffer.slice(0, newline);
      this.#stdinBuffer = this.#stdinBuffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      const message = JSON.parse(line) as Record<string, unknown>;
      const method = typeof message.method === "string" ? message.method : "";
      if (method === "initialize") {
        this.#send({
          id: message.id,
          result: {
            userAgent: "controlled-codex",
            codexHome: "D:\\fake",
            platformFamily: "windows",
            platformOs: "windows",
          },
        });
      } else if (method === "initialized") {
        this.initialized = true;
      } else if (method) {
        this.receivedMethods.push(method);
      }
    }
  }

  #send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

function createControlledAppServer(
  fatals: AppServerFatalError[],
  stdoutExitGraceMs = 40,
): {
  manager: AppServerManager;
  child: () => ControlledAppServerChild;
} {
  let spawnedChild: ControlledAppServerChild | undefined;
  const manager = new AppServerManager(undefined, {
    executable: "controlled-codex",
    prefixArgs: ["--controlled-prefix"],
    environment: {
      HOME: "/controlled/home",
      PATH: "/controlled/bin",
    },
    platform: "darwin",
    requestTimeoutMs: 500,
    stdoutExitGraceMs,
    spawnAppServer: (executable, args, options) => {
      assert.equal(executable, "controlled-codex");
      assert.deepEqual(args, [
        "--controlled-prefix",
        "app-server",
        "--listen",
        "stdio://",
      ]);
      assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.notEqual(options.env, process.env);
      assert.deepEqual(options.env, {
        HOME: "/controlled/home",
        PATH: "/controlled/bin",
      });
      spawnedChild = new ControlledAppServerChild();
      return spawnedChild;
    },
    onFatal: (error) => fatals.push(error),
  });
  return {
    manager,
    child: () => {
      assert.ok(spawnedChild, "controlled app-server child was not spawned");
      return spawnedChild;
    },
  };
}

test("app-server environment policy keeps a safe baseline and explicit passthrough", async (t) => {
  await t.test("retains baseline values, including empty strings, without mutating source", () => {
    const source: NodeJS.ProcessEnv = {
      HOME: "/fake/home",
      PATH: "/fake/bin",
      LANG: "",
      SSH_AUTH_SOCK: "/fake/ssh-agent.sock",
      HTTPS_PROXY: "https://fake-proxy.invalid",
      NODE_EXTRA_CA_CERTS: "/fake/ca.pem",
      UNKNOWN_VAR: "nope",
      SDKROOT: "/fake/sdk",
      OPENAI_API_KEY: "OPENAI_CANARY",
      CONTROL_PLANE_API_KEY: "CONTROL_PLANE_CANARY",
      OPTIONAL_UNDEFINED: undefined,
    };
    const snapshot = { ...source };

    const result = buildAppServerEnv(source, "darwin");

    assert.deepEqual(result, {
      HOME: "/fake/home",
      PATH: "/fake/bin",
      LANG: "",
      SSH_AUTH_SOCK: "/fake/ssh-agent.sock",
      HTTPS_PROXY: "https://fake-proxy.invalid",
      NODE_EXTRA_CA_CERTS: "/fake/ca.pem",
    });
    assert.deepEqual(source, snapshot);
    assert.notEqual(result, source);
  });

  await t.test("passes only explicitly named extra variables", () => {
    const source: NodeJS.ProcessEnv = {
      HOME: "/fake/home",
      SDKROOT: "/fake/sdk",
      CPATH: "/fake/include",
      LIBRARY_PATH: "",
      OPENAI_API_KEY: "OPENAI_CANARY",
      MISSING_VALUE: undefined,
      [APP_SERVER_ENV_PASSTHROUGH]:
        " SDKROOT , CPATH, LIBRARY_PATH , OPENAI_API_KEY, MISSING_VALUE ",
    };

    assert.deepEqual(buildAppServerEnv(source, "darwin"), {
      HOME: "/fake/home",
      SDKROOT: "/fake/sdk",
      CPATH: "/fake/include",
      LIBRARY_PATH: "",
      OPENAI_API_KEY: "OPENAI_CANARY",
    });
  });

  await t.test("treats missing and ASCII-blank passthrough as empty", () => {
    assert.deepEqual(parseAppServerEnvPassthrough(undefined, "darwin"), []);
    assert.deepEqual(
      parseAppServerEnvPassthrough(" \t\v\f\r\n", "darwin"),
      [],
    );
    assert.deepEqual(
      parseAppServerEnvPassthrough(" SDKROOT ,\vCPATH ", "darwin"),
      ["SDKROOT", "CPATH"],
    );
  });

  await t.test("rejects malformed or duplicate passthrough configuration", () => {
    for (const configured of [
      "A,,B",
      ",A",
      "A,",
      "A, ,B",
      "NOT-PORTABLE",
      "ProgramFiles(x86)",
      "A,A",
      "A,\u00a0B",
    ]) {
      assert.throws(
        () => parseAppServerEnvPassthrough(configured, "darwin"),
        /Invalid|Duplicate/,
      );
    }
  });

  await t.test("removes every hard-deny variable and rejects explicit requests", () => {
    const source: NodeJS.ProcessEnv = Object.fromEntries(
      APP_SERVER_HARD_DENY_ENV_NAMES.map((name) => [name, `${name}_CANARY`]),
    );
    assert.deepEqual(buildAppServerEnv(source, "darwin"), {});

    for (const name of APP_SERVER_HARD_DENY_ENV_NAMES) {
      assert.throws(
        () =>
          buildAppServerEnv(
            {
              [name]: `${name}_CANARY`,
              [APP_SERVER_ENV_PASSTHROUGH]: name,
            },
            "darwin",
          ),
        new RegExp(`hard-denied variable ${name}`),
      );
    }
    assert.throws(
      () =>
        buildAppServerEnv(
          {
            control_plane_api_key: "LOWERCASE_CANARY",
            [APP_SERVER_ENV_PASSTHROUGH]: "control_plane_api_key",
          },
          "darwin",
        ),
      /hard-denied variable CONTROL_PLANE_API_KEY/,
    );
  });

  await t.test("uses Windows case-insensitive lookup and rejects ambiguity", () => {
    const source: NodeJS.ProcessEnv = {
      Path: "C:\\fake\\bin",
      userprofile: "C:\\fake\\user",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      sdkroot: "C:\\fake\\sdk",
      OpenAi_Api_Key: "OPENAI_CANARY",
      local_codex_bridge_app_server_env_passthrough:
        "SDKROOT,OPENAI_API_KEY",
    };

    assert.deepEqual(buildAppServerEnv(source, "win32"), {
      Path: "C:\\fake\\bin",
      userprofile: "C:\\fake\\user",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      sdkroot: "C:\\fake\\sdk",
      OpenAi_Api_Key: "OPENAI_CANARY",
    });
    assert.throws(
      () => parseAppServerEnvPassthrough("Path,PATH", "win32"),
      /Duplicate/,
    );
    assert.throws(
      () => buildAppServerEnv({ Path: "one", PATH: "two" }, "win32"),
      /case-ambiguous variable names: PATH/,
    );
    assert.throws(
      () =>
        buildAppServerEnv(
          {
            Control_Plane_Api_Key: "CONTROL_CANARY",
            local_codex_bridge_app_server_env_passthrough:
              "control_plane_api_key",
          },
          "win32",
        ),
      /hard-denied variable CONTROL_PLANE_API_KEY/,
    );
  });

  await t.test("keeps POSIX lookup case-sensitive while deny checks remain case-insensitive", () => {
    assert.deepEqual(
      buildAppServerEnv(
        {
          PATH: "/fake/bin",
          Path: "/different/bin",
          [APP_SERVER_ENV_PASSTHROUGH]: "Path",
        },
        "darwin",
      ),
      {
        PATH: "/fake/bin",
        Path: "/different/bin",
      },
    );
  });

  await t.test("fails in the manager constructor without reporting app-server fatal", () => {
    const fatals: AppServerFatalError[] = [];
    assert.throws(
      () =>
        new AppServerManager(undefined, {
          environment: {
            [APP_SERVER_ENV_PASSTHROUGH]: "A,,B",
          },
          platform: "darwin",
          onFatal: (error) => fatals.push(error),
        }),
      new RegExp(`Invalid ${APP_SERVER_ENV_PASSTHROUGH}`),
    );
    assert.deepEqual(fatals, []);
  });
});

test("AppServerManager spawns with the filtered app-server environment", async () => {
  async function readPresence(
    passthrough: string | undefined,
  ): Promise<Record<string, unknown>> {
    const source: NodeJS.ProcessEnv = {
      CODEX_EXE: process.execPath,
      HOME: "/fake/home",
      PATH: "/fake/bin",
      CONTROL_PLANE_API_KEY: "CONTROL_PLANE_CANARY",
      OPENAI_API_KEY: "OPENAI_CANARY",
      SDKROOT: "/fake/sdk",
      UNKNOWN_VAR: "UNKNOWN_CANARY",
      ...(passthrough === undefined
        ? {}
        : { [APP_SERVER_ENV_PASSTHROUGH]: passthrough }),
    };
    const manager = new AppServerManager(undefined, {
      prefixArgs: [fakeCodex],
      environment: source,
      platform: process.platform,
      requestTimeoutMs: 2_000,
    });
    try {
      return (await manager.request("test/env-presence", {})) as Record<
        string,
        unknown
      >;
    } finally {
      await manager.close();
    }
  }

  assert.deepEqual(await readPresence(undefined), {
    hasControlPlaneApiKey: false,
    hasOpenAiApiKey: false,
    hasHome: true,
    hasPath: true,
    hasSdkRoot: false,
    hasCodexExe: false,
    hasPassthroughConfig: false,
  });
  assert.deepEqual(
    await readPresence("SDKROOT,OPENAI_API_KEY"),
    {
      hasControlPlaneApiKey: false,
      hasOpenAiApiKey: true,
      hasHome: true,
      hasPath: true,
      hasSdkRoot: true,
      hasCodexExe: false,
      hasPassthroughConfig: false,
    },
  );
});

test("control surface starts asynchronously, steers the same turn, uses raw request id, and observes final", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [fakeCodex],
    requestTimeoutMs: 2_000,
  });
  const control = new ControlSurface(manager);
  try {
    const started = await control.call("codex_turn", {
      text: "read only",
      cwd: TEST_CWD,
      sandbox: "read-only",
      approval_policy: "never",
    }) as Record<string, unknown>;
    assert.equal(started.accepted, true);
    assert.equal(started.thread_id, "thread-1");
    assert.equal(started.turn_id, "turn-1");

    const steered = await control.call("codex_steer", {
      thread_id: "thread-1",
      expected_turn_id: "turn-1",
      text: "read another file",
    }) as Record<string, unknown>;
    assert.equal(steered.turn_id, "turn-1");

    await delay(30);
    const active = await control.call("codex_observe", {
      thread_id: "thread-1",
      cursor: 0,
    }) as Record<string, unknown>;
    const pending = active.pending_requests as Array<Record<string, unknown>>;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.request_id, "approval-1");
    assert.equal((pending[0]?.params as Record<string, unknown>).api_key, "[REDACTED]");

    const responded = await control.call("codex_respond", {
      request_id: "approval-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
      method: "item/commandExecution/requestApproval",
      decision: "decline",
    }) as Record<string, unknown>;
    assert.equal(responded.request_id, "approval-1");
    await assert.rejects(
      control.call("codex_respond", {
        request_id: "approval-1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        method: "item/commandExecution/requestApproval",
        decision: "decline",
      }),
      /No pending/,
    );

    await delay(30);
    const completed = await control.call("codex_observe", {
      thread_id: "thread-1",
    }) as Record<string, unknown>;
    assert.equal(completed.runtime_status, "completed");
    assert.equal((completed.terminal as Record<string, unknown>).final_result, "FAKE_FINAL");
  } finally {
    await manager.close();
  }
});

test("unexpected app-server death emits one stable fatal and remains latched", async () => {
  const fatals: AppServerFatalError[] = [];
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [fakeCodex],
    requestTimeoutMs: 2_000,
    stdoutExitGraceMs: 50,
    onFatal: (error) => fatals.push(error),
  });
  try {
    await assert.rejects(
      manager.request("test/exit", {}),
      (error: unknown) =>
        error instanceof AppServerFatalError &&
        /exited unexpectedly/.test(error.message) &&
        /code=23/.test(error.message) &&
        /signal=null/.test(error.message),
    );
    const fatal = fatals[0];
    assert.ok(fatal instanceof AppServerFatalError);
    await assert.rejects(
      manager.request("thread/list", {}),
      (error: unknown) => error === fatal,
    );
    await delay(75);
    assert.equal(fatals.length, 1);
    assert.deepEqual(fatal.toPayload(), {
      error_code: "app_server_fatal",
      status: "app_server_fatal",
      recoverable: true,
      bridge_exiting: true,
      next_action: "restart_or_reconnect_then_codex_threads",
      message: "Codex app-server exited unexpectedly (code=23, signal=null)",
    });
  } finally {
    await manager.close();
  }
});

test("spawn and initialize failures emit one redacted app-server fatal", async (t) => {
  const cases = [
    {
      name: "spawn",
      executable: fileURLToPath(new URL("../../test/does-not-exist-codex", import.meta.url)),
      prefixArgs: [] as string[],
      message: /spawn|ENOENT|Failed to spawn/i,
    },
    {
      name: "initialize",
      executable: process.execPath,
      prefixArgs: [initializeFailureCodex],
      message: /synthetic initialize failure/,
    },
  ];

  for (const current of cases) {
    await t.test(current.name, async () => {
      const fatals: AppServerFatalError[] = [];
      const manager = new AppServerManager(undefined, {
        executable: current.executable,
        prefixArgs: current.prefixArgs,
        requestTimeoutMs: 2_000,
        onFatal: (error) => fatals.push(error),
      });
      try {
        await assert.rejects(
          manager.request("thread/list", {}),
          (error: unknown) => error instanceof AppServerFatalError && current.message.test(error.message),
        );
        assert.equal(fatals.length, 1);
        assert.equal(fatals[0]?.error_code, "app_server_fatal");
        assert.doesNotMatch(fatals[0]?.message ?? "", /must-not-leak/);
        if (current.name === "initialize") {
          assert.match(fatals[0]?.message ?? "", /api_key=\[REDACTED\]/);
        }
      } finally {
        await manager.close();
      }
    });
  }
});

test("normal close before initialize request registration stays typed and non-fatal", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "local-codex-bridge-early-close-"));
  const initializeMarkerPath = join(temporaryDirectory, "initialize-received");
  const closeMarkerPath = join(temporaryDirectory, "stdin-closed");
  const fatals: AppServerFatalError[] = [];
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (error: unknown): void => {
    unhandledRejections.push(error);
  };
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [pendingInitializeCodex, initializeMarkerPath, closeMarkerPath],
    requestTimeoutMs: 2_000,
    onFatal: (error) => fatals.push(error),
  });
  const threadId = "thread-normal-close-before-initialize-registration";
  const turnId = "turn-normal-close-before-initialize-registration";
  manager.runtime.markTurnAccepted(threadId, turnId);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const request = manager.request("thread/list", {});
    const closing = manager.close();
    const [requestResult, closeResult] = await Promise.allSettled([request, closing]);

    assert.equal(requestResult.status, "rejected");
    if (requestResult.status === "rejected") {
      assert.ok(requestResult.reason instanceof AppServerShutdownError);
      assert.equal(requestResult.reason instanceof AppServerFatalError, false);
    }
    assert.equal(closeResult.status, "fulfilled");
    assert.deepEqual(fatals, []);
    assert.equal(existsSync(initializeMarkerPath), false);
    assert.equal(existsSync(closeMarkerPath), true, "close must wait for the fake child to exit");
    const observation = manager.runtime.observe(threadId, 0, 10);
    assert.equal(observation?.runtime_status, "inProgress");
    assert.equal(observation?.active_turn_id, turnId);
    assert.equal(observation?.terminal, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    await manager.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("normal close while initialize is pending rejects with shutdown state and no fatal", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "local-codex-bridge-pending-init-"));
  const markerPath = join(temporaryDirectory, "initialize-pending");
  const fatals: AppServerFatalError[] = [];
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [pendingInitializeCodex, markerPath],
    requestTimeoutMs: 2_000,
    onFatal: (error) => fatals.push(error),
  });
  const threadId = "thread-normal-close-during-initialize";
  const turnId = "turn-normal-close-during-initialize";
  manager.runtime.markTurnAccepted(threadId, turnId);
  try {
    const request = manager.request("thread/list", {});
    await waitForFile(markerPath);
    const closing = manager.close();
    await assert.rejects(request, (error: unknown) => error instanceof AppServerShutdownError);
    await closing;
    assert.deepEqual(fatals, []);
    const observation = manager.runtime.observe(threadId, 0, 10);
    assert.equal(observation?.runtime_status, "inProgress");
    assert.equal(observation?.active_turn_id, turnId);
    assert.equal(observation?.terminal, null);
  } finally {
    await manager.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("initialize fatal keeps priority when its fatal callback concurrently closes", async () => {
  const fatals: AppServerFatalError[] = [];
  const exitCodes: number[] = [];
  let shutdown: Promise<void> | undefined;
  let lifecycle: BridgeLifecycle;
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [initializeFailureCodex],
    requestTimeoutMs: 2_000,
    onFatal: (error) => {
      fatals.push(error);
      shutdown = lifecycle.shutdown(1, "app_server_fatal");
    },
  });
  lifecycle = new BridgeLifecycle({
    async close(): Promise<void> {},
    async closeAfterFatal(): Promise<void> {},
  }, manager, {
    setExitCode: (exitCode) => exitCodes.push(exitCode),
  });

  await assert.rejects(
    manager.request("thread/list", {}),
    (error: unknown) => error === fatals[0] && error instanceof AppServerFatalError,
  );
  await shutdown;
  assert.equal(fatals.length, 1);
  assert.equal(exitCodes.at(-1), 1);
});

test("protocol fatal rejects every app-server RPC and clears active runtime state once", async () => {
  const fatals: AppServerFatalError[] = [];
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [fakeCodex],
    requestTimeoutMs: 2_000,
    onFatal: (error) => fatals.push(error),
  });
  const threadId = "thread-protocol-fatal";
  const turnId = "turn-protocol-fatal";
  try {
    await manager.request("thread/list", {});
    manager.runtime.markTurnAccepted(threadId, turnId);
    assert.equal(
      manager.runtime.recordServerRequest("pending-user-input", "item/tool/requestUserInput", {
        threadId,
        turnId,
        api_key: "must-not-leak",
      }),
      "recorded",
    );

    const fatalRequest = manager.request("test/protocol-failure", {});
    const concurrentRequest = manager.request("thread/list", {});
    const settled = await Promise.allSettled([fatalRequest, concurrentRequest]);
    assert.equal(settled.every((result) => result.status === "rejected"), true);
    for (const result of settled) {
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof AppServerFatalError);
        assert.equal(result.reason, fatals[0]);
      }
    }

    await delay(30);
    assert.equal(fatals.length, 1, "invalid JSON and subsequent child exit must notify once");
    assert.match(fatals[0]?.message ?? "", /invalid app-server JSONL/);
    assert.deepEqual(manager.runtime.pendingForThread(threadId), []);
    const observation = manager.runtime.observe(threadId, 0, 20);
    assert.equal(observation?.runtime_status, "appServerExited");
    assert.equal(observation?.active_turn_id, null);
    assert.equal(observation?.terminal?.turn_id, turnId);
    assert.equal(observation?.terminal?.status, "appServerExited");
    assert.doesNotMatch(JSON.stringify(observation), /must-not-leak/);
  } finally {
    await manager.close();
  }
});

test("app-server stdout connection closure enters the typed fatal lifecycle", async () => {
  const fatals: AppServerFatalError[] = [];
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (error: unknown): void => {
    unhandledRejections.push(error);
  };
  const { manager, child } = createControlledAppServer(fatals, 30);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await manager.ensureReady();
    const fakeChild = child();
    assert.equal(fakeChild.initialized, true);
    const request = manager.request("test/stdout-close", {});
    await waitForCondition(
      () => fakeChild.receivedMethods.includes("test/stdout-close"),
      "controlled child did not receive test/stdout-close",
    );
    await fakeChild.closeStdout();
    await assert.rejects(
      request,
      (error: unknown) =>
        error instanceof AppServerFatalError &&
        /stdout closed unexpectedly/.test(error.message),
    );
    await delay(60);
    assert.equal(fatals.length, 1);
    assert.doesNotMatch(fatals[0]?.message ?? "", /request timed out/);
    assert.equal(fakeChild.exitEvents, 1);
    assert.equal(fakeChild.killCalls, 0);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    await manager.close();
  }
});

test("stdout close followed by exit keeps exit as canonical fatal", async () => {
  const fatals: AppServerFatalError[] = [];
  const { manager, child } = createControlledAppServer(fatals, 40);
  try {
    await manager.ensureReady();
    const fakeChild = child();
    const request = manager.request("test/close-then-exit", {});
    await waitForCondition(
      () => fakeChild.receivedMethods.includes("test/close-then-exit"),
      "controlled child did not receive test/close-then-exit",
    );
    await fakeChild.closeStdout();
    fakeChild.emitExit(23, null);
    await assert.rejects(
      request,
      (error: unknown) =>
        error instanceof AppServerFatalError &&
        /exited unexpectedly/.test(error.message) &&
        /code=23/.test(error.message) &&
        /signal=null/.test(error.message) &&
        !/stdout closed unexpectedly/.test(error.message),
    );
    await delay(80);
    assert.equal(fatals.length, 1);
    assert.equal(fakeChild.exitEvents, 1);
  } finally {
    await manager.close();
  }
});

test("normal close cancels pending stdout-exit grace", async () => {
  const fatals: AppServerFatalError[] = [];
  const { manager, child } = createControlledAppServer(fatals, 30);
  await manager.ensureReady();
  const fakeChild = child();
  await fakeChild.closeStdout();
  await manager.close();
  await delay(60);
  assert.deepEqual(fatals, []);
  assert.equal(fakeChild.exitEvents, 1);
  assert.equal(fakeChild.killCalls, 0);
});

test("visible exit state makes stdout close use the exit fatal", async () => {
  const fatals: AppServerFatalError[] = [];
  const { manager, child } = createControlledAppServer(fatals, 40);
  try {
    await manager.ensureReady();
    const fakeChild = child();
    const request = manager.request("test/visible-exit-state", {});
    await waitForCondition(
      () => fakeChild.receivedMethods.includes("test/visible-exit-state"),
      "controlled child did not receive test/visible-exit-state",
    );
    fakeChild.setExitState(23, null);
    await fakeChild.closeStdout();
    await assert.rejects(
      request,
      (error: unknown) =>
        error instanceof AppServerFatalError &&
        error.message === "Codex app-server exited unexpectedly (code=23, signal=null)",
    );
    await delay(80);
    assert.equal(fatals.length, 1);
    assert.equal(fakeChild.exitEvents, 0, "visible exit state must not require a synthetic exit event");
  } finally {
    await manager.close();
  }
});

test("stdout exit grace requires a positive integer", () => {
  for (const stdoutExitGraceMs of [0, -1, 1.5]) {
    assert.throws(
      () => new AppServerManager(undefined, { stdoutExitGraceMs }),
      /stdoutExitGraceMs must be a positive integer/,
    );
  }
});

test("fatal, signal, and repeated shutdown requests coordinate one nonzero top-level close", async () => {
  let normalServerCloses = 0;
  let fatalServerCloses = 0;
  let appServerCloses = 0;
  let uxCloses = 0;
  const exitCodes: number[] = [];
  const server = {
    async close(): Promise<void> {
      normalServerCloses += 1;
    },
    async closeAfterFatal(timeoutMs?: number): Promise<void> {
      assert.equal(timeoutMs, 250);
      fatalServerCloses += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
  const appServer = {
    async close(): Promise<void> {
      appServerCloses += 1;
    },
    runtime: {
      closeUxProjection(): void {
        uxCloses += 1;
      },
    },
  };
  const lifecycle = new BridgeLifecycle(server, appServer, {
    fatalDrainTimeoutMs: 250,
    setExitCode: (exitCode) => exitCodes.push(exitCode),
  });

  const first = lifecycle.shutdown(1, "app_server_fatal");
  const concurrentSignal = lifecycle.shutdown(0, "normal");
  const repeatedFatal = lifecycle.shutdown(1, "app_server_fatal");
  assert.equal(first, concurrentSignal);
  assert.equal(first, repeatedFatal);
  await Promise.all([first, concurrentSignal, repeatedFatal]);

  assert.equal(normalServerCloses, 0);
  assert.equal(fatalServerCloses, 1);
  assert.equal(appServerCloses, 1);
  assert.equal(uxCloses, 1);
  assert.equal(exitCodes.at(-1), 1);
  assert.equal(exitCodes.every((code) => code === 1), true);
});

test("normal top-level close keeps normal exit semantics", async () => {
  let normalServerCloses = 0;
  let fatalServerCloses = 0;
  let appServerCloses = 0;
  let uxCloses = 0;
  let exitCode = -1;
  const lifecycle = new BridgeLifecycle({
    async close(): Promise<void> {
      normalServerCloses += 1;
    },
    async closeAfterFatal(): Promise<void> {
      fatalServerCloses += 1;
    },
  }, {
    async close(): Promise<void> {
      appServerCloses += 1;
    },
    runtime: {
      closeUxProjection(): void {
        uxCloses += 1;
      },
    },
  }, {
    setExitCode: (value) => {
      exitCode = value;
    },
  });

  await lifecycle.shutdown(0, "normal");
  assert.equal(normalServerCloses, 1);
  assert.equal(fatalServerCloses, 0);
  assert.equal(appServerCloses, 1);
  assert.equal(uxCloses, 1);
  assert.equal(exitCode, 0);
});

test("explicit app-server close does not emit a fatal notification", async () => {
  const fatals: AppServerFatalError[] = [];
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [fakeCodex],
    requestTimeoutMs: 2_000,
    onFatal: (error) => fatals.push(error),
  });
  await manager.request("thread/list", {});
  await manager.close();
  assert.deepEqual(fatals, []);
});

test("failed app-server response write restores the original pending request", async () => {
  const manager = new RejectingResponseManager();
  const control = new ControlSurface(manager);
  manager.runtime.markTurnAccepted("thread-restore", "turn-restore");
  manager.runtime.recordServerRequest(41, "item/fileChange/requestApproval", {
    threadId: "thread-restore",
    turnId: "turn-restore",
  });

  try {
    await assert.rejects(
      control.call("codex_respond", {
        request_id: 41,
        thread_id: "thread-restore",
        turn_id: "turn-restore",
        method: "item/fileChange/requestApproval",
        decision: "decline",
      }),
      /synthetic app-server response write failure/,
    );
    assert.equal(manager.lastResponseId, 41);
    const pending = manager.runtime.pendingForThread("thread-restore") as Array<Record<string, unknown>>;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.request_id, 41);
  } finally {
    await manager.close();
  }
});

test("threadless app-server server request receives an explicit JSON-RPC error", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [fakeCodex],
    requestTimeoutMs: 2_000,
  });
  try {
    const result = await manager.request("test/threadless", {}) as Record<string, unknown>;
    assert.equal(result.clientErrorId, "threadless-1");
    assert.deepEqual(result.clientError, {
      code: -32601,
      message: "Unsupported app-server request without thread context",
    });
    const listed = await manager.request("thread/list", {}) as Record<string, unknown>;
    assert.equal(Array.isArray(listed.data), true);
  } finally {
    await manager.close();
  }
});

test("mutating app-server acknowledgement timeouts report unknown outcome without retry", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [timeoutCodex],
    requestTimeoutMs: 20,
  });
  try {
    for (const method of ["thread/start", "thread/resume", "turn/start", "turn/steer", "turn/interrupt"]) {
      await assert.rejects(
        manager.request(method, {}),
        (error: unknown) => {
          assert.match(String(error), /acknowledgement timed out/);
          assert.match(String(error), /operation outcome is UNKNOWN/);
          assert.match(String(error), /Re-observe or read before retrying/);
          return true;
        },
      );
    }
    await assert.rejects(
      manager.request("thread/list", {}),
      /Codex app-server request timed out: thread\/list/,
    );
    const count = await manager.request("test/count", {}) as Record<string, unknown>;
    // App-server startup sends initialize plus the initialized notification.
    assert.equal(count.requestCount, 9);
  } finally {
    await manager.close();
  }
});

test("mutating timeout stays UNKNOWN while the native write remains pending", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [pendingWriteCodex],
    requestTimeoutMs: 25,
  });
  try {
    await assert.rejects(
      manager.request("turn/start", { payload: "x".repeat(2_000_000) }),
      (error: unknown) => {
        assert.match(String(error), /acknowledgement timed out/);
        assert.match(String(error), /operation outcome is UNKNOWN/);
        assert.doesNotMatch(String(error), /Codex app-server request timed out: turn\/start/);
        return true;
      },
    );
    await delay(250);
    assert.deepEqual(await manager.request("test/after", {}), { after: true });
  } finally {
    await manager.close();
  }
});

test("late turn/start responses reconcile conservatively around native notifications", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [lateResponseCodex, "120"],
    requestTimeoutMs: 30,
  });
  try {
    const threadIds = [
      "thread-no-notification",
      "thread-native-started",
      "thread-native-terminal",
    ];
    await Promise.all(threadIds.map(async (threadId) => {
      await assert.rejects(
        manager.request("turn/start", { threadId, input: [] }),
        /operation outcome is UNKNOWN/,
      );
    }));
    await delay(170);

    const noNotification = manager.runtime.observe("thread-no-notification", 0, 10)!;
    assert.equal(noNotification.active_turn_id, "turn-thread-no-notification");
    assert.equal(
      (noNotification.events.at(-1)?.data as Record<string, unknown>).action,
      "turn_activated",
    );

    const nativeStarted = manager.runtime.observe("thread-native-started", 0, 10)!;
    assert.equal(nativeStarted.active_turn_id, "turn-thread-native-started");
    assert.equal(
      (nativeStarted.events.at(-1)?.data as Record<string, unknown>).reason,
      "turn_already_active",
    );

    const nativeTerminal = manager.runtime.observe("thread-native-terminal", 0, 10)!;
    assert.equal(nativeTerminal.active_turn_id, null);
    assert.equal(nativeTerminal.terminal?.turn_id, "turn-thread-native-terminal");
    assert.equal(nativeTerminal.terminal?.final_result, "TERMINAL");
    assert.equal(
      (nativeTerminal.events.at(-1)?.data as Record<string, unknown>).reason,
      "terminal_present",
    );

    const state = await manager.request("test/state", {}) as Record<string, unknown>;
    assert.equal(state.turnStart, 3);
  } finally {
    await manager.close();
  }
});

test("late thread/start and thread/resume become observable without a follow-on turn", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [lateResponseCodex, "120"],
    requestTimeoutMs: 30,
  });
  const control = new ControlSurface(manager);
  try {
    await assert.rejects(
      control.call("codex_turn", { text: "new thread", cwd: TEST_CWD }),
      /operation outcome is UNKNOWN/,
    );
    await assert.rejects(
      control.call("codex_turn", {
        text: "resume thread",
        thread_id: "thread-resume-late",
        cwd: TEST_CWD,
      }),
      /operation outcome is UNKNOWN/,
    );
    await delay(170);

    assert.equal(manager.runtime.observe("late-thread-1", 0, 10)?.runtime_status, "idle");
    assert.equal(manager.runtime.observe("thread-resume-late", 0, 10)?.runtime_status, "idle");
    const state = await manager.request("test/state", {}) as Record<string, unknown>;
    assert.equal(state.threadStart, 1);
    assert.equal(state.threadResume, 1);
    assert.equal(state.turnStart, 0);
    assert.equal(state.turnInterrupt, 0);
  } finally {
    await manager.close();
  }
});

test("late steer and interrupt acknowledgements are observable without lifecycle mutation", async () => {
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [lateResponseCodex, "120"],
    requestTimeoutMs: 30,
  });
  manager.runtime.markTurnAccepted("thread-steer-late", "turn-steer-late");
  manager.runtime.markTurnAccepted("thread-interrupt-late", "turn-interrupt-late");
  manager.runtime.markTurnAccepted("thread-steer-error", "turn-steer-error");
  try {
    await Promise.all([
      assert.rejects(
        manager.request("turn/steer", {
          threadId: "thread-steer-late",
          expectedTurnId: "turn-steer-late",
          input: [],
        }),
        /operation outcome is UNKNOWN/,
      ),
      assert.rejects(
        manager.request("turn/interrupt", {
          threadId: "thread-interrupt-late",
          turnId: "turn-interrupt-late",
        }),
        /operation outcome is UNKNOWN/,
      ),
      assert.rejects(
        manager.request("turn/steer", {
          threadId: "thread-steer-error",
          expectedTurnId: "turn-steer-error",
          input: [],
          testLateError: true,
        }),
        /operation outcome is UNKNOWN/,
      ),
    ]);
    await delay(170);

    for (const [threadId, turnId] of [
      ["thread-steer-late", "turn-steer-late"],
      ["thread-interrupt-late", "turn-interrupt-late"],
    ] as const) {
      const observed = manager.runtime.observe(threadId, 0, 10)!;
      assert.equal(observed.active_turn_id, turnId);
      assert.equal(
        (observed.events.at(-1)?.data as Record<string, unknown>).reason,
        "late_success_no_lifecycle_change",
      );
    }
    const errored = manager.runtime.observe("thread-steer-error", 0, 10)!;
    assert.equal(errored.active_turn_id, "turn-steer-error");
    const errorData = errored.events.at(-1)?.data as Record<string, unknown>;
    assert.equal(errorData.reason, "late_error");
    assert.doesNotMatch(
      JSON.stringify(errorData.error),
      /FAKE_FIXTURE_SECRET_1234567890/,
    );
    assert.match(JSON.stringify(errorData.error), /REDACTED/);

    const state = await manager.request("test/state", {}) as Record<string, unknown>;
    assert.equal(state.turnSteer, 2);
    assert.equal(state.turnInterrupt, 1);
  } finally {
    await manager.close();
  }
});

test("late response retention expires, evicts oldest entries, and consumes unscoped errors", async () => {
  const expiring = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [lateResponseCodex, "120"],
    requestTimeoutMs: 20,
    lateResponseTtlMs: 35,
  });
  try {
    await assert.rejects(
      expiring.request("thread/start", { testThreadId: "thread-expired" }),
      /operation outcome is UNKNOWN/,
    );
    await delay(170);
    assert.equal(expiring.runtime.hasThread("thread-expired"), false);
  } finally {
    await expiring.close();
  }

  const capped = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [lateResponseCodex, "120"],
    requestTimeoutMs: 20,
    lateResponseTtlMs: 500,
    lateResponseLimit: 2,
  });
  try {
    await Promise.all(["thread-cap-1", "thread-cap-2", "thread-cap-3"].map(async (threadId) => {
      await assert.rejects(
        capped.request("thread/start", { testThreadId: threadId }),
        /operation outcome is UNKNOWN/,
      );
    }));
    await delay(170);
    assert.equal(capped.runtime.hasThread("thread-cap-1"), false);
    assert.equal(capped.runtime.hasThread("thread-cap-2"), true);
    assert.equal(capped.runtime.hasThread("thread-cap-3"), true);

    await assert.rejects(
      capped.request("thread/start", {
        testThreadId: "thread-after-error",
        testLateError: true,
      }),
      /operation outcome is UNKNOWN/,
    );
    await delay(180);
    assert.equal(capped.runtime.hasThread("thread-after-error"), false);
  } finally {
    await capped.close();
  }
});

test("duplicate app-server request ids fail the protocol without an ambiguous response", async () => {
  const logPath = fileURLToPath(new URL(
    `../../test/.duplicate-request-${process.pid}-${Date.now()}.log`,
    import.meta.url,
  ));
  const manager = new AppServerManager(undefined, {
    executable: process.execPath,
    prefixArgs: [duplicateRequestCodex, logPath],
    requestTimeoutMs: 2_000,
  });
  try {
    await assert.rejects(
      manager.request("test/duplicate", {}),
      /protocol anomaly: duplicate outstanding number request id/,
    );
    assert.equal(manager.runtime.hasThread("thread-duplicate"), false);
    const original = manager.runtime.observe("thread-original", 0, 10)!;
    const stringTyped = manager.runtime.observe("thread-string", 0, 10)!;
    assert.equal(original.events[0]?.method, "item/fileChange/requestApproval");
    assert.equal(
      ((original.events[0]?.data as Record<string, unknown>).params as Record<string, unknown>).marker,
      "original",
    );
    assert.equal(stringTyped.events[0]?.method, "item/tool/requestUserInput");
    assert.equal(
      (stringTyped.events[0]?.data as Record<string, unknown>).request_id,
      "17",
    );
  } finally {
    await manager.close();
  }
  try {
    const childLog = await readFile(logPath, "utf8");
    assert.match(childLog, /stdin-closed/);
    assert.doesNotMatch(childLog, /ambiguous-response/);
  } finally {
    await rm(logPath, { force: true });
  }
});

test("unsupported pending app-server requests remain observable and are never answered", async () => {
  const manager = new RejectingResponseManager();
  const control = new ControlSurface(manager);
  manager.runtime.markTurnAccepted("thread-unknown", "turn-unknown");
  manager.runtime.recordServerRequest("future-1", "test/unknownServerRequest", {
    threadId: "thread-unknown",
    turnId: "turn-unknown",
    api_key: "must-redact",
    detail: "keep this pending",
  });
  try {
    await assert.rejects(
      control.call("codex_respond", {
        request_id: "future-1",
        thread_id: "thread-unknown",
        turn_id: "turn-unknown",
        method: "test/unknownServerRequest",
        response: { guessed: true },
      }),
      /Unsupported app-server request method: test\/unknownServerRequest; pending request remains observable/,
    );
    assert.equal(manager.lastResponseId, undefined);
    const observed = manager.runtime.observe("thread-unknown", 0, 10);
    const pending = observed?.pending_requests as Array<Record<string, unknown>>;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.request_id, "future-1");
    assert.equal(pending[0]?.method, "test/unknownServerRequest");
    assert.equal(pending[0]?.thread_id, "thread-unknown");
    assert.equal(pending[0]?.turn_id, "turn-unknown");
    assert.equal((pending[0]?.params as Record<string, unknown>).api_key, "[REDACTED]");
  } finally {
    await manager.close();
  }
});

test("codex_respond metadata does not advertise generic future-method responses", () => {
  const respondTool = TOOL_DEFINITIONS.find((tool) => tool.name === "codex_respond");
  assert.match(respondTool?.description ?? "", /Unsupported or unknown methods fail locally and remain pending/);
  const response = (respondTool?.inputSchema.properties as Record<string, unknown>).response as Record<string, unknown>;
  assert.match(response.description as string, /unsupported or future methods remain pending/);
});

test("serialized app-server writes preserve order and wait for drain", async () => {
  const sink = new ControlledBackpressureSink();
  const write = createSerializedWriter((chunk) =>
    writeWithBackpressure(sink as unknown as Writable, chunk),
  );
  let firstResolved = false;
  const first = write("first\n").then(() => {
    firstResolved = true;
  });
  const second = write("second\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sink.chunks, ["first\n"]);
  sink.completeWrite();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstResolved, false);
  assert.deepEqual(sink.chunks, ["first\n"]);
  sink.emit("drain");
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstResolved, true);
  assert.deepEqual(sink.chunks, ["first\n", "second\n"]);
  sink.completeWrite();
  sink.emit("drain");
  await second;
});

test("serialized initialized notification preserves typed shutdown while queued", async () => {
  const shutdownError = new AppServerShutdownError();
  let shuttingDown = false;
  let releaseInitializeWrite: (() => void) | undefined;
  let markInitializeWriteStarted: (() => void) | undefined;
  const initializeWriteStarted = new Promise<void>((resolve) => {
    markInitializeWriteStarted = resolve;
  });
  const initializeWriteGate = new Promise<void>((resolve) => {
    releaseInitializeWrite = resolve;
  });
  const write = createSerializedWriter(async (chunk) => {
    if (shuttingDown) {
      throw shutdownError;
    }
    if (chunk === "initialize\n") {
      markInitializeWriteStarted?.();
      await initializeWriteGate;
    }
  });

  const initializeWrite = write("initialize\n");
  await initializeWriteStarted;
  const initializedNotificationWrite = write("initialized\n");
  const initializedRejection = assert.rejects(
    initializedNotificationWrite,
    (error: unknown) => error === shutdownError && error instanceof AppServerShutdownError,
  );
  shuttingDown = true;
  releaseInitializeWrite?.();

  await initializeWrite;
  await initializedRejection;
});

test("app-server stream writes reject on error or close and the chain recovers", async () => {
  const errorSink = new ControlledBackpressureSink();
  const errorWrite = writeWithBackpressure(
    errorSink as unknown as Writable,
    "error\n",
  );
  const errorAssertion = assert.rejects(errorWrite, /synthetic stream failure/);
  errorSink.emit("error", new Error("synthetic stream failure"));
  await errorAssertion;

  const closedSink = new ControlledBackpressureSink();
  const closedWrite = writeWithBackpressure(
    closedSink as unknown as Writable,
    "closed\n",
  );
  const closeAssertion = assert.rejects(closedWrite, /stdin closed during write/);
  closedSink.emit("close");
  await closeAssertion;

  let attempts = 0;
  const recoveringWrite = createSerializedWriter(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("synthetic queued failure");
    }
  });
  await assert.rejects(recoveringWrite("first\n"), /synthetic queued failure/);
  await recoveringWrite("second\n");
  assert.equal(attempts, 2);
});
