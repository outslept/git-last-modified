import { spawn } from "node:child_process";
import { relative, resolve, sep } from "node:path";

export interface GitHistoryOptions {
  cwd?: string;
  allowShallow?: boolean;
}

export interface LastUpdatedInfo {
  date: Date;
  timestamp: number;
  author: string;
  hash: string;
}

export interface GitHistory {
  get(filePath: string): Promise<LastUpdatedInfo | null>;
  getAll(): Promise<Map<string, LastUpdatedInfo>>;
  /** @alias get */
  getLastUpdatedInfo(filePath: string): Promise<LastUpdatedInfo | null>;
}

interface Repository {
  root: string;
  trackedFiles: Set<string>;
  hasCommits: boolean;
}

interface StoredUpdate {
  timestamp: number;
  author: string;
  hash: string;
}

type LogPhase = "hash" | "timestamp" | "author" | "status" | "path";

const HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const STATUS_PATTERN = /^[ACDMRTUXB]\d*$/;
const MAX_STDERR_LENGTH = 8 * 1024;
const STOP_STREAM = Symbol("STOP_STREAM");

export function createGitHistory(options: GitHistoryOptions = {}): GitHistory {
  const cwd = resolve(options.cwd ?? process.cwd());
  let repositoryPromise: Promise<Repository> | undefined;
  let historyPromise: Promise<Map<string, StoredUpdate>> | undefined;

  function getRepository(): Promise<Repository> {
    return (repositoryPromise ??= (async () => {
      const revOut = removeTrailingNewline(
        await gitText(cwd, ["rev-parse", "--show-toplevel", "--is-shallow-repository"]),
      );
      const newlineIdx = revOut.lastIndexOf("\n");
      const root = resolve(removeTrailingNewline(revOut.slice(0, newlineIdx)));
      const isShallow = revOut.slice(newlineIdx + 1).trim();

      if (isShallow === "true" && !options.allowShallow) {
        throw new Error(
          "Shallow git checkout: last-updated dates would be wrong for every file. " +
            "Fetch the full history first (git fetch --unshallow, or fetch-depth: 0 in CI).",
        );
      }

      const trackedFiles = new Set<string>();
      await forEachNulToken(root, ["ls-files", "-z"], (file) => {
        trackedFiles.add(file);
      });

      return { root, trackedFiles, hasCommits: await hasCommits(root) };
    })().catch((err) => {
      repositoryPromise = undefined;
      throw err;
    }));
  }

  function getHistoryMap(repository: Repository): Promise<Map<string, StoredUpdate>> {
    if (!repository.hasCommits || repository.trackedFiles.size === 0) {
      return Promise.resolve(new Map());
    }
    return (historyPromise ??= readHistory(repository.root, repository.trackedFiles).catch(
      (err) => {
        historyPromise = undefined;
        throw err;
      },
    ));
  }

  async function get(filePath: string): Promise<LastUpdatedInfo | null> {
    if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) {
      throw new TypeError("filePath must be a non-empty path string");
    }
    const repository = await getRepository();
    const rel = relative(repository.root, resolve(cwd, filePath));
    const gitPath = sep === "/" ? rel : rel.split(sep).join("/");
    if (!repository.trackedFiles.has(gitPath)) {
      return null;
    }
    const update = (await getHistoryMap(repository)).get(gitPath);
    return update ? toInfo(update) : null;
  }

  async function getAll(): Promise<Map<string, LastUpdatedInfo>> {
    const repository = await getRepository();
    const updates = await getHistoryMap(repository);
    const result = new Map<string, LastUpdatedInfo>();
    for (const [path, update] of updates) {
      result.set(path, toInfo(update));
    }
    return result;
  }

  return {
    get,
    getAll,
    getLastUpdatedInfo: get,
  };
}

export async function getLastModified(
  filePath: string,
  options?: GitHistoryOptions,
): Promise<LastUpdatedInfo | null> {
  return createGitHistory(options).get(filePath);
}

export async function getLastModifiedMap(
  options?: GitHistoryOptions,
): Promise<Map<string, LastUpdatedInfo>> {
  return createGitHistory(options).getAll();
}

function toInfo(update: StoredUpdate): LastUpdatedInfo {
  return {
    date: new Date(update.timestamp),
    timestamp: update.timestamp,
    author: update.author,
    hash: update.hash,
  };
}

async function readHistory(
  root: string,
  trackedFiles: ReadonlySet<string>,
): Promise<Map<string, StoredUpdate>> {
  const updates = new Map<string, StoredUpdate>();
  const targetCount = trackedFiles.size;
  let phase: LogPhase = "hash";
  let currentHash = "";
  let timestamp = 0;
  let currentUpdate: StoredUpdate | undefined;

  await forEachNulToken(
    root,
    [
      "log",
      "--no-show-signature",
      "--root",
      "--date-order",
      "-m",
      "--no-renames",
      "--name-status",
      "-z",
      "--encoding=UTF-8",
      "--format=%H%x00%at%x00%an",
    ],
    (token) => {
      switch (phase) {
        case "hash": {
          const hash = stripProtocolLineBreaks(token);
          if (!hash) return;
          if (!HASH_PATTERN.test(hash)) {
            throw new Error("Unexpected output from git log");
          }
          currentHash = hash;
          phase = "timestamp";
          return;
        }
        case "timestamp": {
          const value = stripProtocolLineBreaks(token);
          if (!/^-?\d+$/.test(value)) {
            throw new Error("Unexpected commit timestamp from git log");
          }
          const seconds = Number(value);
          timestamp = seconds * 1000;
          if (
            !Number.isSafeInteger(seconds) ||
            !Number.isFinite(timestamp) ||
            Math.abs(timestamp) > 8_640_000_000_000_000
          ) {
            throw new Error("Commit timestamp is outside the supported range");
          }
          phase = "author";
          return;
        }
        case "author":
          currentUpdate = {
            hash: currentHash,
            timestamp,
            author: token.replace(/[\r\n]+$/, ""),
          };
          phase = "status";
          return;
        case "status": {
          const status = stripProtocolLineBreaks(token);
          if (!status) return;
          if (HASH_PATTERN.test(status)) {
            currentHash = status;
            currentUpdate = undefined;
            phase = "timestamp";
            return;
          }
          if (!STATUS_PATTERN.test(status)) {
            throw new Error("Unexpected file status from git log");
          }
          phase = "path";
          return;
        }
        case "path":
          if (currentUpdate && trackedFiles.has(token) && !updates.has(token)) {
            updates.set(token, currentUpdate);
            if (updates.size === targetCount) {
              return STOP_STREAM;
            }
          }
          phase = "status";
      }
    },
  );
  return updates;
}

async function hasCommits(cwd: string): Promise<boolean> {
  try {
    await gitText(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  const chunks: Buffer[] = [];
  await runGit(cwd, args, (chunk) => {
    chunks.push(chunk);
  });
  return Buffer.concat(chunks).toString("utf8");
}

async function forEachNulToken(
  cwd: string,
  args: string[],
  onToken: (token: string) => void | typeof STOP_STREAM,
): Promise<void> {
  let pending: Buffer = Buffer.alloc(0);
  let stopped = false;

  await runGit(cwd, args, (chunk) => {
    const input = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    while (true) {
      const end = input.indexOf(0, start);
      if (end === -1) break;
      if (onToken(input.toString("utf8", start, end)) === STOP_STREAM) {
        stopped = true;
        return STOP_STREAM;
      }
      start = end + 1;
    }
    pending = start < input.length ? Buffer.from(input.subarray(start)) : Buffer.alloc(0);
  });

  if (!stopped && pending.length) {
    onToken(pending.toString("utf8"));
  }
}

async function runGit(
  cwd: string,
  args: string[],
  onChunk: (chunk: Buffer) => void | typeof STOP_STREAM,
): Promise<void> {
  const child = spawn("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let spawnError: Error | undefined;
  let stoppedEarly = false;

  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR_LENGTH) {
      stderr += chunk.toString("utf8").slice(0, MAX_STDERR_LENGTH - stderr.length);
    }
  });

  const closed = new Promise<void>((resolveClosed) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", () => resolveClosed());
  });

  try {
    for await (const chunk of child.stdout) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (onChunk(buf) === STOP_STREAM) {
        stoppedEarly = true;
        child.kill();
        break;
      }
    }
  } catch (error) {
    child.kill();
    await closed;
    if (spawnError) {
      throw new Error(`Unable to start git: ${spawnError.message}`);
    }
    if (!stoppedEarly) {
      throw error;
    }
  }

  await closed;
  if (spawnError) {
    throw new Error(`Unable to start git: ${spawnError.message}`);
  }
  if (!stoppedEarly && child.exitCode !== 0) {
    const detail = stderr.trim();
    const status =
      child.exitCode === null
        ? `signal ${child.signalCode ?? "unknown"}`
        : `exit code ${child.exitCode}`;
    throw new Error(`git ${args[0]} failed (${status})${detail ? `: ${detail}` : ""}`);
  }
}

function removeTrailingNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function stripProtocolLineBreaks(value: string): string {
  return value.replace(/^[\r\n]+|[\r\n]+$/g, "");
}
