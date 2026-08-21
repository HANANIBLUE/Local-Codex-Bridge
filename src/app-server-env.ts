export const APP_SERVER_ENV_PASSTHROUGH =
  "LOCAL_CODEX_BRIDGE_APP_SERVER_ENV_PASSTHROUGH";

export const APP_SERVER_HARD_DENY_ENV_NAMES = [
  "CONTROL_PLANE_API_KEY",
  "OPENAI_ADMIN_KEY",
  "CLOUDFLARED_TUNNEL_TOKEN",
  "CONTROL_PLANE_CLIENT_KEY",
  "CONTROL_PLANE_EXTRA_HEADERS",
  "MCP_CLIENT_KEY",
  "MCP_EXTRA_HEADERS",
  "MCP_DISCOVERY_EXTRA_HEADERS",
] as const;

export const APP_SERVER_BASELINE_ENV_NAMES = [
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "CODEX_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

export const APP_SERVER_WINDOWS_BASELINE_ENV_NAMES = [
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
] as const;

const PORTABLE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HARD_DENY_NAMES = new Set<string>(APP_SERVER_HARD_DENY_ENV_NAMES);

interface SourceEntry {
  name: string;
  value: string | undefined;
}

function asciiUppercase(value: string): string {
  return value.replace(/[a-z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) - 32),
  );
}

function trimAsciiWhitespace(value: string): string {
  return value
    .replace(/^[\t\n\v\f\r ]+/, "")
    .replace(/[\t\n\v\f\r ]+$/, "");
}

function lookupKey(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? asciiUppercase(name) : name;
}

function hardDenyKey(name: string): string {
  return asciiUppercase(name);
}

function isHardDenied(name: string): boolean {
  return HARD_DENY_NAMES.has(hardDenyKey(name));
}

function indexSourceEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Map<string, SourceEntry> {
  const index = new Map<string, SourceEntry>();
  for (const name of Object.keys(source)) {
    const key = lookupKey(name, platform);
    const existing = index.get(key);
    if (existing && existing.name !== name) {
      throw new Error(
        `App-server source environment contains case-ambiguous variable names: ${key}`,
      );
    }
    index.set(key, { name, value: source[name] });
  }
  return index;
}

export function parseAppServerEnvPassthrough(
  configured: string | undefined,
  platform: NodeJS.Platform,
): readonly string[] {
  if (configured === undefined || trimAsciiWhitespace(configured) === "") {
    return [];
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const [index, rawName] of configured.split(",").entries()) {
    const name = trimAsciiWhitespace(rawName);
    if (name === "" || !PORTABLE_ENV_NAME.test(name)) {
      throw new Error(
        `Invalid ${APP_SERVER_ENV_PASSTHROUGH} variable name at item ${index + 1}`,
      );
    }
    const duplicateKey = lookupKey(name, platform);
    if (seen.has(duplicateKey)) {
      throw new Error(
        `Duplicate ${APP_SERVER_ENV_PASSTHROUGH} variable name: ${duplicateKey}`,
      );
    }
    if (isHardDenied(name)) {
      throw new Error(
        `${APP_SERVER_ENV_PASSTHROUGH} cannot include hard-denied variable ${hardDenyKey(name)}`,
      );
    }
    seen.add(duplicateKey);
    names.push(name);
  }
  return names;
}

function copyIfPresent(
  target: NodeJS.ProcessEnv,
  sourceIndex: ReadonlyMap<string, SourceEntry>,
  requestedName: string,
  platform: NodeJS.Platform,
): void {
  const entry = sourceIndex.get(lookupKey(requestedName, platform));
  if (!entry || entry.value === undefined || isHardDenied(entry.name)) {
    return;
  }
  target[entry.name] = entry.value;
}

export function buildAppServerEnv(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const sourceIndex = indexSourceEnvironment(source, platform);
  const passthroughConfig = sourceIndex.get(
    lookupKey(APP_SERVER_ENV_PASSTHROUGH, platform),
  )?.value;
  const passthroughNames = parseAppServerEnvPassthrough(
    passthroughConfig,
    platform,
  );
  const childEnvironment: NodeJS.ProcessEnv = {};

  for (const name of APP_SERVER_BASELINE_ENV_NAMES) {
    copyIfPresent(childEnvironment, sourceIndex, name, platform);
  }
  if (platform === "win32") {
    for (const name of APP_SERVER_WINDOWS_BASELINE_ENV_NAMES) {
      copyIfPresent(childEnvironment, sourceIndex, name, platform);
    }
  }
  for (const name of passthroughNames) {
    copyIfPresent(childEnvironment, sourceIndex, name, platform);
  }

  for (const name of Object.keys(childEnvironment)) {
    if (isHardDenied(name)) {
      delete childEnvironment[name];
    }
  }
  return childEnvironment;
}
