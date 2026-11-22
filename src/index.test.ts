import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { createGitHistory, getLastModified, getLastModifiedMap } from "./index.ts";

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env,
  });
}

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "git-last-modified-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  return root;
}

function cleanDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function commit(
  root: string,
  author: string,
  timestamp: number,
  files?: string[],
  extraArgs: string[] = [],
): string {
  if (files) {
    git(root, ["add", "--", ...files]);
  } else if (extraArgs.length === 0) {
    git(root, ["add", "--all"]);
  }
  git(root, ["commit", "--quiet", "-m", author, ...extraArgs], {
    ...process.env,
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: "author@example.test",
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: "committer@example.test",
    GIT_AUTHOR_DATE: `@${timestamp} +0000`,
    GIT_COMMITTER_DATE: `@${timestamp} +0000`,
  });
  return git(root, ["rev-parse", "HEAD"]).trim();
}

test("shares Git history across tracked, renamed, staged-only, and subdirectory paths", async () => {
  const root = createRepository();
  try {
    mkdirSync(join(root, "docs"), { recursive: true });
    const unusualName = process.platform === "win32" ? "line break.md" : "line\nbreak.md";
    writeFileSync(join(root, "docs", unusualName), "initial\n");
    commit(root, "Initial", 1_690_000_000, [`docs/${unusualName}`]);

    writeFileSync(join(root, "docs", "page.md"), "first\n");
    writeFileSync(join(root, "docs", unusualName), "unusual\n");
    const originalHash = commit(root, "Original", 1_700_000_000, [
      "docs/page.md",
      `docs/${unusualName}`,
    ]);

    writeFileSync(join(root, "docs", "page.md"), "updated\n");
    commit(root, "Editor", 1_710_000_000, ["docs/page.md"]);

    renameSync(join(root, "docs", "page.md"), join(root, "docs", "renamed.md"));
    const renamerHash = commit(root, "Renamer", 1_720_000_000);

    commit(root, "EmptyCommit", 1_730_000_000, undefined, ["--allow-empty"]);

    // Early-exit check when all tracked files are committed
    const fullMap = await getLastModifiedMap({ cwd: root });
    expect(fullMap.size).toBe(2);
    expect(fullMap.get("docs/renamed.md")).toEqual({
      date: new Date(1_720_000_000 * 1000),
      timestamp: 1_720_000_000 * 1000,
      author: "Renamer",
      hash: renamerHash,
    });

    // Add staged-only file (in ls-files, but not in git log)
    writeFileSync(join(root, "docs", "uncommitted.md"), "draft\n");
    git(root, ["add", "docs/uncommitted.md"]);

    const history = createGitHistory({ cwd: root });
    const subDirHistory = createGitHistory({ cwd: join(root, "docs") });

    const [renamed, fromSubDir, unusual, uncommitted, untracked, outside, oldPath, oneShot] =
      await Promise.all([
        history.get(join(root, "docs", "renamed.md")),
        subDirHistory.getLastUpdatedInfo("renamed.md"),
        history.get(`docs/${unusualName}`),
        history.get("docs/uncommitted.md"),
        history.get("not-tracked.md"),
        history.get("../outside.md"),
        history.get("docs/page.md"),
        getLastModified("docs/renamed.md", { cwd: root }),
      ]);

    expect(renamed).toEqual({
      date: new Date(1_720_000_000 * 1000),
      timestamp: 1_720_000_000 * 1000,
      author: "Renamer",
      hash: renamerHash,
    });
    expect(fromSubDir).toEqual(renamed);
    expect(oneShot).toEqual(renamed);
    expect(unusual).toEqual({
      date: new Date(1_700_000_000 * 1000),
      timestamp: 1_700_000_000 * 1000,
      author: "Original",
      hash: originalHash,
    });
    expect(uncommitted).toBeNull();
    expect(untracked).toBeNull();
    expect(outside).toBeNull();
    expect(oldPath).toBeNull();
  } finally {
    cleanDir(root);
  }
});

test("handles unborn repo, shallow checkout, invalid inputs, and git errors", async () => {
  const root = createRepository();
  const nonGitDir = mkdtempSync(join(tmpdir(), "git-last-modified-nongit-"));
  try {
    const defaultHistory = createGitHistory();
    await expect(defaultHistory.get(null as unknown as string)).rejects.toThrow(TypeError);
    await expect(defaultHistory.get("")).rejects.toThrow(TypeError);
    await expect(defaultHistory.get("bad\0path")).rejects.toThrow(TypeError);

    writeFileSync(join(root, "staged.md"), "staged\n");
    git(root, ["add", "staged.md"]);

    const unbornHistory = createGitHistory({ cwd: root });
    expect(await unbornHistory.get("staged.md")).toBeNull();
    expect((await unbornHistory.getAll()).size).toBe(0);

    const headHash = commit(root, "Initial", 1_700_000_000);
    writeFileSync(join(root, ".git", "shallow"), `${headHash}\n`);

    const shallowHistory = createGitHistory({ cwd: root });
    await expect(shallowHistory.get("staged.md")).rejects.toThrow(/Shallow git checkout/);

    const allowedShallow = await getLastModified("staged.md", {
      cwd: root,
      allowShallow: true,
    });
    expect(allowedShallow).toEqual({
      date: new Date(1_700_000_000 * 1000),
      timestamp: 1_700_000_000 * 1000,
      author: "Initial",
      hash: headHash,
    });

    const brokenHistory = createGitHistory({ cwd: nonGitDir });
    await expect(brokenHistory.get("file.md")).rejects.toThrow(/git rev-parse failed/);

    const missingCwdHistory = createGitHistory({ cwd: join(nonGitDir, "missing") });
    await expect(missingCwdHistory.get("file.md")).rejects.toThrow(/Unable to start git/);
  } finally {
    cleanDir(root);
    cleanDir(nonGitDir);
  }
});
