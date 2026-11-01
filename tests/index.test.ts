import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { createGitHistory } from "../src/index.js";

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

function commit(root: string, author: string, timestamp: number, files?: string[]): void {
  git(root, files ? ["add", "--", ...files] : ["add", "--all"]);

  git(root, ["commit", "--quiet", "-m", author], {
    ...process.env,
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: "author@example.test",
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: "committer@example.test",
    GIT_AUTHOR_DATE: `@${timestamp} +0000`,
    GIT_COMMITTER_DATE: `@${timestamp} +0000`,
  });
}

test("shares Git history across tracked, renamed, and untracked paths", async () => {
  const root = createRepository();

  try {
    mkdirSync(join(root, "docs"), { recursive: true });

    const unusualName = process.platform === "win32" ? "line break.md" : "line\nbreak.md";
    writeFileSync(join(root, "docs", "page.md"), "first\n");
    writeFileSync(join(root, "docs", unusualName), "unusual\n");

    commit(root, "Original", 1_700_000_000, ["docs/page.md", `docs/${unusualName}`]);

    writeFileSync(join(root, "docs", "page.md"), "updated\n");
    commit(root, "Editor", 1_710_000_000, ["docs/page.md"]);

    renameSync(join(root, "docs", "page.md"), join(root, "docs", "renamed.md"));
    commit(root, "Renamer", 1_720_000_000);

    const history = createGitHistory({ cwd: root });

    const [renamed, unusual, untracked, outside, oldPath] = await Promise.all([
      history.getLastUpdatedInfo(join(root, "docs", "renamed.md")),
      history.getLastUpdatedInfo(`docs/${unusualName}`),
      history.getLastUpdatedInfo("not-tracked.md"),
      history.getLastUpdatedInfo("../outside.md"),
      history.getLastUpdatedInfo("docs/page.md"),
    ]);

    expect(renamed).toEqual({
      date: new Date(1_720_000_000 * 1000),
      author: "Renamer",
    });
    expect(unusual).toEqual({
      date: new Date(1_700_000_000 * 1000),
      author: "Original",
    });
    expect(untracked).toBeNull();
    expect(outside).toBeNull();
    expect(oldPath).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
