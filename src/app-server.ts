import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import {
  RuntimeStore,
  redactText,
  sanitizeForTransport,
  type RpcId,
} from "./runtime.js";

const MAX_JSONL_BYTES = 10 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_LATE_RESPONSE_TTL_MS = 60_000;
const DEFAULT_LATE_RESPONSE_LIMIT = 256;
const DEFAULT_STDOUT_EXIT_GRACE_MS = 500;
const MAX_SCOPE_ID_CHARS = 200;
const THREADLESS_REQUEST_ERROR = {
  code: -32601,
  message: "Unsupported app-server request without thread context",
} as const;
const MUTATING_REQUEST_METHODS = new Set([
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

type LateResponseCandidate =
  | { method: "thread/start" }
  | { method: "thread/resume"; requestedThreadId: string }
  | { method: "turn/start"; requestedThreadId: string }
  | {
      method: "turn/steer" | "turn/interrupt";
      requestedThreadId: string;
      requestedTurnId: string;
    };

interface RetainedLateResponse {
  candidate: LateResponseCandidate;
  timedOutAt: string;
  expiresAtMs: number;
}

export interface AppServerLaunchOptions {
  executable?: string;
  prefixArgs?: readonly string[];
  requestTimeoutMs?: number;
  lateResponseTtlMs?: number;
  lateResponseLimit?: number;
  stdoutExitGraceMs?: number;
  spawnAppServer?: SpawnAppServer;
  onFatal?: (error: AppServerFatalError) => void;
}

type AppServerChildEvents = {
  spawn: [];
  error: [error: Error];
  exit: [code: number | null, signal: NodeJS.Signals | null];
};

export interface AppServerChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  on<Event extends keyof AppServerChildEvents>(
    event: Event,
    listener: (...args: AppServerChildEvents[Event]) => void,
  ): this;
  once<Event extends keyof AppServerChildEvents>(
    event: Event,
    listener: (...args: AppServerChildEvents[Event]) => void,
  ): this;
  off<Event extends keyof AppServerChildEvents>(
    event: Event,
    listener: (...args: AppServerChildEvents[Event]) => void,
  ): this;
  kill(signal?: number | NodeJS.Signals): boolean;
}

export interface AppServerSpawnOptions {
  stdio: ["pipe", "pipe", "pipe"];
  shell: false;
  windowsHide: true;
  env: NodeJS.ProcessEnv;
}

export type SpawnAppServer = (
  executable: string,
  args: readonly string[],
  options: AppServerSpawnOptions,
) => AppServerChild;

const defaultSpawnAppServer: SpawnAppServer = (executable, args, options) =>
  spawn(executable, [...args], options);

export interface AppServerFatalPayload {
  error_code: "app_server_fatal";
  status: "app_server_fatal";
  recoverable: true;
  bridge_exiting: true;
  next_action: "restart_or_reconnect_then_codex_threads";
  message: string;
}

export class AppServerShutdownError extends Error {
  constructor(message = "Codex app-server manager is shutting down") {
    super(message);
    this.name = "AppServerShutdownError";
  }
}

export class AppServerFatalError extends Error {
  readonly error_code = "app_server_fatal" as const;
  readonly status = "app_server_fatal" as const;
  readonly recoverable = true as const;
  readonly bridge_exiting = true as const;
  readonly next_action = "restart_or_reconnect_then_codex_threads" as const;

  constructor(message: string) {
    super(redactText(message));
    this.name = "AppServerFatalError";
  }

  toPayload(): AppServerFatalPayload {
    return {
      error_code: this.error_code,
      status: this.status,
      recoverable: this.recoverable,
      bridge_exiting: this.bridge_exiting,
      next_action: this.next_action,
      message: this.message,
    };
  }
}

function rpcKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedScopeId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SCOPE_ID_CHARS
    ? value
    : undefined;
}

function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function lateResponseCandidate(
  method: string,
  params: unknown,
): LateResponseCandidate | undefined {
  if (method === "thread/start") {
    return { method };
  }
  const record = asRecord(params);
  if (method === "turn/steer" || method === "turn/interrupt") {
    const requestedThreadId = boundedScopeId(record?.threadId);
    const requestedTurnId = boundedScopeId(
      method === "turn/steer" ? record?.expectedTurnId : record?.turnId,
    );
    return requestedThreadId && requestedTurnId
      ? { method, requestedThreadId, requestedTurnId }
      : undefined;
  }
  if (method !== "thread/resume" && method !== "turn/start") {
    return undefined;
  }
  const requestedThreadId = boundedScopeId(record?.threadId);
  return requestedThreadId ? { method, requestedThreadId } : undefined;
}

function messageFromUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(sanitizeForTransport(value));
  } catch {
    return String(value);
  }
}

function requestTimeoutError(method: string): Error {
  if (MUTATING_REQUEST_METHODS.has(method)) {
    return new Error(
      `Codex app-server acknowledgement timed out for already-sent mutating request ${method}; operation outcome is UNKNOWN because Codex may already have accepted it. Re-observe or read before retrying. No automatic retry is performed.`,
    );
  }
  return new Error(`Codex app-server request timed out: ${method}`);
}

export function resolveCodexExecutable(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = environment.CODEX_EXE?.trim();
  if (explicit) {
    if (/[\0\r\n]/.test(explicit)) {
      throw new Error("CODEX_EXE contains an invalid control character");
    }
    return explicit;
  }
  return "codex";
}

async function waitForExit(
  child: AppServerChild,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

export function writeWithBackpressure(
  stream: Writable,
  chunk: string,
): Promise<void> {
  if (!stream.writable || stream.writableEnded || stream.destroyed) {
    return Promise.reject(new Error("Codex app-server stdin is not writable"));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let writeReturned = false;
    let callbackDone = false;
    let drainDone = false;

    const cleanup = (): void => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const maybeResolve = (): void => {
      if (!settled && writeReturned && callbackDone && drainDone) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const onDrain = (): void => {
      drainDone = true;
      maybeResolve();
    };
    const onError = (error: Error): void => fail(error);
    const onClose = (): void =>
      fail(new Error("Codex app-server stdin closed during write"));
    const onWrite = (error?: Error | null): void => {
      if (error) {
        fail(error);
        return;
      }
      callbackDone = true;
      maybeResolve();
    };

    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
    try {
      const accepted = stream.write(chunk, "utf8", onWrite);
      if (settled) {
        return;
      }
      if (accepted) {
        drainDone = true;
        stream.off("drain", onDrain);
      }
      writeReturned = true;
      maybeResolve();
    } catch (error) {
      fail(
        error instanceof Error
          ? error
          : new Error(messageFromUnknown(error)),
      );
    }
  });
}

export function createSerializedWriter(
  write: (chunk: string) => Promise<void>,
): (chunk: string) => Promise<void> {
  let tail = Promise.resolve();
  return async (chunk: string): Promise<void> => {
    const current = tail.then(() => write(chunk));
    tail = current.catch(() => undefined);
    await current;
  };
}

export class AppServerManager {
  readonly runtime: RuntimeStore;

  readonly #executable: string;
  readonly #prefixArgs: readonly string[];
  readonly #requestTimeoutMs: number;
  readonly #lateResponseTtlMs: number;
  readonly #lateResponseLimit: number;
  readonly #stdoutExitGraceMs: number;
  readonly #spawnAppServer: SpawnAppServer;
  readonly #onFatal: ((error: AppServerFatalError) => void) | undefined;
  readonly #pendingCalls = new Map<string, PendingCall>();
  readonly #lateResponses = new Map<string, RetainedLateResponse>();
  readonly #writeLine: (chunk: string) => Promise<void>;

  #child: AppServerChild | null = null;
  #stdoutExitGrace: { child: AppServerChild; timer: NodeJS.Timeout } | null = null;
  #startPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #childShutdownPromise: Promise<void> | null = null;
  #fatal: AppServerFatalError | null = null;
  #shutdownError: AppServerShutdownError | null = null;
  #fatalNotified = false;
  #closing = false;
  #initialized = false;
  #nextRequestId = 1;
  #stdoutBuffer = Buffer.alloc(0);

  constructor(
    runtime = new RuntimeStore(),
    options: AppServerLaunchOptions = {},
  ) {
    this.runtime = runtime;
    this.#executable = options.executable ?? resolveCodexExecutable();
    this.#prefixArgs = options.prefixArgs ?? [];
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#lateResponseTtlMs = positiveIntegerOption(
      options.lateResponseTtlMs,
      DEFAULT_LATE_RESPONSE_TTL_MS,
      "lateResponseTtlMs",
    );
    this.#lateResponseLimit = positiveIntegerOption(
      options.lateResponseLimit,
      DEFAULT_LATE_RESPONSE_LIMIT,
      "lateResponseLimit",
    );
    this.#stdoutExitGraceMs = positiveIntegerOption(
      options.stdoutExitGraceMs,
      DEFAULT_STDOUT_EXIT_GRACE_MS,
      "stdoutExitGraceMs",
    );
    this.#spawnAppServer = options.spawnAppServer ?? defaultSpawnAppServer;
    this.#onFatal = options.onFatal;
    this.#writeLine = createSerializedWriter(async (chunk) => {
      this.#throwIfUnavailable();
      const child = this.#child;
      if (
        !child ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        throw new Error("Codex app-server stdin is not writable");
      }
      await writeWithBackpressure(child.stdin, chunk);
    });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.ensureReady();
    return await this.#request(method, params, this.#requestTimeoutMs);
  }

  async respond(id: RpcId, result: unknown): Promise<void> {
    await this.ensureReady();
    await this.#write({ id, result });
  }

  async ensureReady(): Promise<void> {
    this.#throwIfUnavailable();
    if (this.#initialized && this.#child) {
      return;
    }
    if (!this.#startPromise) {
      this.#startPromise = this.#start();
    }
    await this.#startPromise;
  }

  async close(): Promise<void> {
    if (this.#closePromise) {
      return await this.#closePromise;
    }
    this.#closePromise = this.#close();
    return await this.#closePromise;
  }

  async #start(): Promise<void> {
    let child: AppServerChild;
    try {
      child = this.#spawnAppServer(
        this.#executable,
        [...this.#prefixArgs, "app-server", "--listen", "stdio://"],
        {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
          env: process.env,
        },
      );
    } catch (error) {
      throw this.#enterFatal(
        `Failed to spawn ${this.#executable}: ${messageFromUnknown(error)}`,
      );
    }

    this.#clearStdoutExitGrace();
    this.#child = child;
    child.stdin.on("error", (error) => this.#onStdinError(child, error));
    child.stdin.once("close", () => this.#onStdinClose(child));
    child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    child.stdout.once("error", (error) => this.#onStdoutError(child, error));
    child.stdout.once("close", () => this.#onStdoutClose(child));
    child.stderr.on("data", () => {
      // Drain without forwarding potentially sensitive child diagnostics.
    });
    child.stderr.on("error", () => {
      // stderr is diagnostics-only. Drain stream errors so they cannot bypass
      // the app-server lifecycle through an unhandled EventEmitter error.
    });
    child.once("exit", (code, signal) => this.#onExit(child, code, signal));

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = (): void => {
          child.off("error", onError);
          resolve();
        };
        const onError = (error: Error): void => {
          child.off("spawn", onSpawn);
          reject(error);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
      child.on("error", (error) => this.#onChildError(child, error));
      this.#throwIfUnavailable();

      await this.#request(
        "initialize",
        {
          clientInfo: {
            name: "local-codex-bridge",
            title: "Local Codex Bridge",
            version: "2.2.0",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: false,
            optOutNotificationMethods: [],
          },
        },
        30_000,
      );
      this.#throwIfUnavailable();
      await this.#write({ method: "initialized", params: {} });
      this.#throwIfUnavailable();
      this.#initialized = true;
    } catch (error) {
      if (this.#fatal) {
        await this.#shutdownChild(500);
        throw this.#fatal;
      }
      if (error instanceof AppServerFatalError) {
        await this.#shutdownChild(500);
        throw error;
      }
      if (this.#closing && error instanceof AppServerShutdownError) {
        throw error;
      }
      const failure = this.#enterFatal(
        `Codex app-server initialization failed: ${messageFromUnknown(error)}`,
      );
      await this.#shutdownChild(500);
      throw failure;
    }
  }

  #request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    this.#throwIfUnavailable();
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const key = rpcKey(id);
    const lateCandidate = lateResponseCandidate(method, params);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pendingCalls.delete(key)) {
          return;
        }
        if (lateCandidate) {
          this.#retainLateResponse(key, lateCandidate);
        }
        reject(requestTimeoutError(method));
      }, timeoutMs);
      this.#pendingCalls.set(key, { method, resolve, reject, timer });
      void this.#write({ method, id, params }).catch((error: unknown) => {
        const pending = this.#pendingCalls.get(key);
        if (!pending) {
          this.#lateResponses.delete(key);
          return;
        }
        clearTimeout(pending.timer);
        this.#pendingCalls.delete(key);
        pending.reject(this.#requestWriteFailure(method, error));
      });
    });
  }

  #requestWriteFailure(method: string, error: unknown): Error {
    if (this.#fatal) {
      return this.#fatal;
    }
    if (error instanceof AppServerShutdownError || error instanceof AppServerFatalError) {
      return error;
    }
    return new Error(
      `Failed to write app-server request ${method}: ${messageFromUnknown(error)}`,
    );
  }

  #retainLateResponse(key: string, candidate: LateResponseCandidate): void {
    const now = Date.now();
    for (const [retainedKey, retained] of this.#lateResponses) {
      if (retained.expiresAtMs <= now) {
        this.#lateResponses.delete(retainedKey);
      }
    }
    while (this.#lateResponses.size >= this.#lateResponseLimit) {
      const oldest = this.#lateResponses.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.#lateResponses.delete(oldest);
    }
    this.#lateResponses.set(key, {
      candidate,
      timedOutAt: new Date(now).toISOString(),
      expiresAtMs: now + this.#lateResponseTtlMs,
    });
  }

  #takeLateResponse(key: string): RetainedLateResponse | undefined {
    const retained = this.#lateResponses.get(key);
    if (!retained) {
      return undefined;
    }
    this.#lateResponses.delete(key);
    return retained.expiresAtMs > Date.now() ? retained : undefined;
  }

  #reconcileLateResponse(
    retained: RetainedLateResponse,
    response: Record<string, unknown>,
  ): void {
    if (response.error !== undefined && response.error !== null) {
      const candidate = retained.candidate;
      if (candidate.method !== "thread/start") {
        const turnId = candidate.method === "turn/steer" || candidate.method === "turn/interrupt"
          ? candidate.requestedTurnId
          : undefined;
        this.runtime.recordLateMutationError({
          method: candidate.method,
          threadId: candidate.requestedThreadId,
          ...(turnId ? { turnId } : {}),
          timedOutAt: retained.timedOutAt,
          error: response.error,
        });
      }
      return;
    }
    const result = asRecord(response.result);
    if (!result) {
      return;
    }
    const candidate = retained.candidate;
    if (candidate.method === "thread/start" || candidate.method === "thread/resume") {
      const threadId = boundedScopeId(asRecord(result.thread)?.id);
      if (
        !threadId ||
        (candidate.method === "thread/resume" &&
          threadId !== candidate.requestedThreadId)
      ) {
        return;
      }
      this.runtime.reconcileLateMutationSuccess({
        method: candidate.method,
        threadId,
        timedOutAt: retained.timedOutAt,
      });
      return;
    }

    if (candidate.method === "turn/steer" || candidate.method === "turn/interrupt") {
      this.runtime.reconcileLateMutationSuccess({
        method: candidate.method,
        threadId: candidate.requestedThreadId,
        turnId: candidate.requestedTurnId,
        timedOutAt: retained.timedOutAt,
      });
      return;
    }

    const turn = asRecord(result.turn);
    const turnId = boundedScopeId(turn?.id);
    if (!turnId) {
      return;
    }
    const status = typeof turn?.status === "string" && turn.status.length > 0
      ? turn.status
      : undefined;
    this.runtime.reconcileLateMutationSuccess({
      method: candidate.method,
      threadId: candidate.requestedThreadId,
      turnId,
      ...(status ? { status } : {}),
      timedOutAt: retained.timedOutAt,
    });
  }

  async #write(message: unknown): Promise<void> {
    const encoded = `${JSON.stringify(message)}\n`;
    try {
      await this.#writeLine(encoded);
    } catch (error) {
      if (this.#fatal) {
        throw this.#fatal;
      }
      if (error instanceof AppServerShutdownError || error instanceof AppServerFatalError) {
        throw error;
      }
      if (this.#closing) {
        throw this.#normalShutdownError();
      }
      throw this.#enterFatal(
        `Codex app-server stdin write failed: ${messageFromUnknown(error)}`,
      );
    }
  }

  #normalShutdownError(): AppServerShutdownError {
    this.#shutdownError ??= new AppServerShutdownError();
    return this.#shutdownError;
  }

  #throwIfUnavailable(): void {
    if (this.#fatal) {
      throw this.#fatal;
    }
    if (this.#closing) {
      throw this.#normalShutdownError();
    }
  }

  #onStdout(chunk: Buffer): void {
    if (this.#fatal || this.#closing) {
      return;
    }
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    while (true) {
      const newline = this.#stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#stdoutBuffer.length > MAX_JSONL_BYTES) {
          this.#protocolFailure("app-server JSONL line exceeded 10 MiB");
        }
        return;
      }
      if (newline > MAX_JSONL_BYTES) {
        this.#protocolFailure("app-server JSONL line exceeded 10 MiB");
        return;
      }
      let line = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      if (line.length === 0) {
        continue;
      }
      try {
        this.#dispatch(JSON.parse(line.toString("utf8")) as unknown);
        if (this.#fatal) {
          return;
        }
      } catch (error) {
        this.#protocolFailure(`invalid app-server JSONL: ${messageFromUnknown(error)}`);
        return;
      }
    }
  }

  #dispatch(message: unknown): void {
    const record = asRecord(message);
    if (!record) {
      throw new Error("app-server emitted a non-object message");
    }
    const method = typeof record.method === "string" ? record.method : undefined;
    const id =
      typeof record.id === "string" || typeof record.id === "number"
        ? record.id
        : undefined;

    if (method) {
      if (id !== undefined) {
        const recorded = this.runtime.recordServerRequest(id, method, record.params);
        if (recorded === "threadless") {
          void this.#write({
            id,
            error: THREADLESS_REQUEST_ERROR,
          }).catch((error: unknown) => {
            this.#protocolFailure(
              `failed to reject unsupported app-server request: ${messageFromUnknown(error)}`,
            );
          });
        } else if (recorded === "duplicate") {
          this.#protocolFailure(
            `app-server protocol anomaly: duplicate outstanding ${typeof id} request id`,
          );
        }
      } else {
        this.runtime.recordNotification(method, record.params);
      }
      return;
    }
    if (id === undefined) {
      throw new Error("app-server response has no request id");
    }
    const pending = this.#pendingCalls.get(rpcKey(id));
    if (!pending) {
      const retained = this.#takeLateResponse(rpcKey(id));
      if (retained) {
        this.#reconcileLateResponse(retained, record);
      }
      return;
    }
    clearTimeout(pending.timer);
    this.#pendingCalls.delete(rpcKey(id));
    if ("error" in record && record.error !== undefined && record.error !== null) {
      const errorRecord = asRecord(record.error);
      const detail =
        typeof errorRecord?.message === "string"
          ? errorRecord.message
          : messageFromUnknown(record.error);
      pending.reject(
        new Error(`Codex app-server ${pending.method} failed: ${redactText(detail)}`),
      );
    } else {
      pending.resolve(record.result);
    }
  }

  #protocolFailure(message: string): void {
    this.#enterFatal(message);
  }

  #onChildError(child: AppServerChild, error: Error): void {
    this.#clearStdoutExitGrace(child);
    if (child !== this.#child || this.#closing) {
      return;
    }
    this.#enterFatal(`Codex app-server process error: ${error.message}`);
  }

  #onStdinError(child: AppServerChild, error: Error): void {
    if (child !== this.#child || this.#closing || this.#fatal) {
      return;
    }
    this.#protocolFailure(
      `Codex app-server stdin failed: ${messageFromUnknown(error)}`,
    );
  }

  #onStdinClose(child: AppServerChild): void {
    if (
      child !== this.#child ||
      this.#closing ||
      this.#fatal ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }
    this.#protocolFailure("Codex app-server stdin closed unexpectedly");
  }

  #onStdoutError(child: AppServerChild, error: Error): void {
    this.#clearStdoutExitGrace(child);
    if (child !== this.#child || this.#closing || this.#fatal) {
      return;
    }
    this.#protocolFailure(
      `Codex app-server stdout failed: ${messageFromUnknown(error)}`,
    );
  }

  #onStdoutClose(child: AppServerChild): void {
    if (child !== this.#child || this.#closing || this.#fatal) {
      this.#clearStdoutExitGrace(child);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#clearStdoutExitGrace(child);
      this.#enterExitFatal(child, child.exitCode, child.signalCode);
      return;
    }
    if (this.#stdoutExitGrace?.child === child) {
      return;
    }
    this.#clearStdoutExitGrace();
    const timer = setTimeout(
      () => this.#onStdoutExitGrace(child),
      this.#stdoutExitGraceMs,
    );
    timer.unref();
    this.#stdoutExitGrace = { child, timer };
  }

  #onStdoutExitGrace(child: AppServerChild): void {
    if (this.#stdoutExitGrace?.child !== child) {
      return;
    }
    this.#stdoutExitGrace = null;
    if (child !== this.#child || this.#closing || this.#fatal) {
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#enterExitFatal(child, child.exitCode, child.signalCode);
      return;
    }
    this.#protocolFailure("Codex app-server stdout closed unexpectedly");
  }

  #clearStdoutExitGrace(child?: AppServerChild): void {
    const pending = this.#stdoutExitGrace;
    if (!pending || (child && pending.child !== child)) {
      return;
    }
    clearTimeout(pending.timer);
    this.#stdoutExitGrace = null;
  }

  #onExit(
    child: AppServerChild,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.#clearStdoutExitGrace(child);
    this.#enterExitFatal(child, code, signal);
  }

  #enterExitFatal(
    child: AppServerChild,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (child !== this.#child) {
      return;
    }
    this.#initialized = false;
    if (this.#closing) {
      return;
    }
    this.#enterFatal(
      `Codex app-server exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
    );
  }

  #enterFatal(message: string): AppServerFatalError {
    this.#clearStdoutExitGrace();
    if (this.#fatal) {
      return this.#fatal;
    }
    const failure = new AppServerFatalError(message);
    this.#fatal = failure;
    this.runtime.markAppServerExited(failure.message);
    this.#rejectAll(failure);
    void this.#shutdownChild(500);
    if (!this.#fatalNotified) {
      this.#fatalNotified = true;
      try {
        this.#onFatal?.(failure);
      } catch {
        // The manager owns local fatal cleanup. Top-level shutdown remains
        // best effort and callback failures must not replace the root cause.
      }
    }
    return failure;
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pendingCalls.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pendingCalls.clear();
    this.#lateResponses.clear();
  }

  async #close(): Promise<void> {
    const shutdownError = this.#normalShutdownError();
    this.#closing = true;
    this.#clearStdoutExitGrace();
    this.#rejectAll(this.#fatal ?? shutdownError);
    await this.#shutdownChild(1_500);
    this.#child = null;
  }

  #shutdownChild(graceMs: number): Promise<void> {
    if (this.#childShutdownPromise) {
      return this.#childShutdownPromise;
    }
    const child = this.#child;
    if (!child) {
      return Promise.resolve();
    }
    this.#clearStdoutExitGrace(child);
    this.#childShutdownPromise = (async () => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.stdin.end();
      if (!(await waitForExit(child, graceMs))) {
        child.kill();
        await waitForExit(child, 1_000);
      }
    })();
    return this.#childShutdownPromise;
  }
}
