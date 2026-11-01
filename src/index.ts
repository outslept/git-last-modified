import { spawn } from "node:child_process";
import { relative, resolve, sep } from "node:path";

export interface GitHistoryOptions {
  cwd?: string;
}

export interface LastUpdatedInfo {
  date: Date;
  author: string;
}

export interface GitHistory {
  getLastUpdatedInfo(filePath: string): Promise<LastUpdatedInfo | null>;
}

interface Repository {
  root: string;
  trackedFiles: Set<string>;
  hasCommits: boolean;
}

interface StoredUpdate {
  timestampMs: number;
  author: string;
}

type LogPhase = "hash" | "timestamp" | "author" | "status" | "path";

const HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const STATUS_PATTERN = /^[ACDMRTUXB]\d*$/;
const MAX_STDERR_LENGTH = 8 * 1024;

export function createGitHistory(options: GitHistoryOptions = {}): GitHistory {
  const cwd = resolve(options.cwd ?? process.cwd());

  let repositoryPromise: Promise<Repository> | undefined;
  let historyPromise: Promise<Map<string, StoredUpdate>> | undefined;

  function getRepository(): Promise<Repository> {
    repositoryPromise ??= (async () => {
      const rootOutput = await gitText(cwd, ["rev-parse", "--show-toplevel"]);
      const root = resolve(removeTrailingNewline(rootOutput));

      const isShallow = removeTrailingNewline(
        await gitText(root, ["rev-parse", "--is-shallow-repository"]),
      );
      if (isShallow === "true") {
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
    })();

    return repositoryPromise;
  }

  return {
    async getLastUpdatedInfo(filePath) {
      if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) {
        throw new TypeError("filePath must be a non-empty path string");
      }

      const repository = await getRepository();
      const gitPath = relative(repository.root, resolve(cwd, filePath)).split(sep).join("/");

      if (!repository.trackedFiles.has(gitPath)) {
        return null;
      }

      historyPromise ??= repository.hasCommits
        ? readHistory(repository.root, repository.trackedFiles)
        : Promise.resolve(new Map<string, StoredUpdate>());

      const update = (await historyPromise).get(gitPath);

      return update ? { date: new Date(update.timestampMs), author: update.author } : null;
    },
  };
}

async function readHistory(
  root: string,
  trackedFiles: ReadonlySet<string>,
): Promise<Map<string, StoredUpdate>> {
  const updates = new Map<string, StoredUpdate>();

  let phase: LogPhase = "hash";
  let timestampMs = 0;
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
          phase = "timestamp";
          return;
        }

        case "timestamp": {
          const value = stripProtocolLineBreaks(token);
          if (!/^-?\d+$/.test(value)) {
            throw new Error("Unexpected commit timestamp from git log");
          }

          const seconds = Number(value);
          timestampMs = seconds * 1000;

          if (
            !Number.isSafeInteger(seconds) ||
            !Number.isFinite(timestampMs) ||
            Math.abs(timestampMs) > 8_640_000_000_000_000
          ) {
            throw new Error("Commit timestamp is outside the supported range");
          }

          phase = "author";
          return;
        }

        case "author":
          currentUpdate = {
            timestampMs,
            author: token.replace(/[\r\n]+$/, ""),
          };
          phase = "status";
          return;

        case "status": {
          const status = stripProtocolLineBreaks(token);
          if (!status) return;

          if (HASH_PATTERN.test(status)) {
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
  await runGit(cwd, args, (chunk) => chunks.push(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function forEachNulToken(
  cwd: string,
  args: string[],
  onToken: (token: string) => void,
): Promise<void> {
  let pending = Buffer.alloc(0);

  await runGit(cwd, args, (chunk) => {
    const input = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;

    while (true) {
      const end = input.indexOf(0, start);
      if (end === -1) break;

      onToken(input.toString("utf8", start, end));
      start = end + 1;
    }

    pending = start < input.length ? Buffer.from(input.subarray(start)) : Buffer.alloc(0);
  });

  if (pending.length) {
    onToken(pending.toString("utf8"));
  }
}

async function runGit(
  cwd: string,
  args: string[],
  onChunk: (chunk: Buffer) => void,
): Promise<void> {
  const child = spawn("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  let spawnError: Error | undefined;

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
      onChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch (error) {
    child.kill();
    await closed;

    if (spawnError) {
      throw new Error(`Unable to start git: ${spawnError.message}`);
    }

    throw error;
  }

  await closed;

  if (spawnError) {
    throw new Error(`Unable to start git: ${spawnError.message}`);
  }

  if (child.exitCode !== 0) {
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
