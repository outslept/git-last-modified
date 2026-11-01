# git-last-modified

Get the last committed author and date for files in a Git repository.

Designed for many file lookups: the first tracked-file request builds a shared, in-memory history index instead of spawning one Git process per file.

Requires Node.js and the `git` executable. The package has no runtime dependencies.

## Usage

```ts
const history = createGitHistory({ cwd: process.cwd() });

const info = await history.getLastUpdatedInfo("docs/test.md");

if (info) {
  console.log(info.date);
  console.log(info.author);
}
```

## API

`createGitHistory(options?)`

Create a history reader for a Git repository.

```ts
createGitHistory({ cwd?: string })
```

- `cwd` - repository directory or a directory inside it. Defaults to `process.cwd()`.

`history.getLastUpdatedInfo(filePath)`

```ts
getLastUpdatedInfo(
  filePath: string,
): Promise<{ date: Date; author: string } | null>
```

- `filePath` may be relative to `cwd` or absolute.

Returns `null` if the path is outside the repository, is not in the current Git index, or has no commit in the available history. Git command failures reject the promise.

`date` is the commit author's timestamp; `author` is the Git author name.
