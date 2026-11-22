# git-last-modified

Get the last committed author, timestamp, and commit hash for files in a Git repository.

Queries the repository in a single streaming `git log -z` pass with early termination once all tracked files are resolved. Zero dependencies.

## Usage

### Single file or full repository map

```ts
import { getLastModified, getLastModifiedMap } from "git-last-modified";

const info = await getLastModified("src/index.ts");
// {
//   date: 2026-02-14T12:00:00.000Z,
//   timestamp: 1771070400000,
//   author: "eugene",
//   hash: "a1b2c3d4..."
// }

const allFiles = await getLastModifiedMap();
const readmeInfo = allFiles.get("README.md");
```

### Shared instance (recommended for build tools & SSG plugins)

`createGitHistory` caches the repository index and commit map across concurrent lookups:

```ts
import { createGitHistory } from "git-last-modified";

const history = createGitHistory({ cwd: process.cwd() });

const [a, b] = await Promise.all([history.get("docs/intro.md"), history.get("docs/api.md")]);
```

## API

### `getLastModified(filePath, options?): Promise<LastUpdatedInfo | null>`

Returns the most recent commit metadata for `filePath`, or `null` if the file is untracked or has never been committed.

### `getLastModifiedMap(options?): Promise<Map<string, LastUpdatedInfo>>`

Returns a `Map` keyed by repository-relative POSIX paths (`"src/index.ts"`) for all committed tracked files.

### `createGitHistory(options?): GitHistory`

Creates a cached instance with `.get(filePath)`, `.getAll()`, and `.getLastUpdatedInfo(filePath)`.

#### `GitHistoryOptions`

| Option         | Type      | Default         | Description                                                                       |
| :------------- | :-------- | :-------------- | :-------------------------------------------------------------------------------- |
| `cwd`          | `string`  | `process.cwd()` | Working directory inside the target Git repository.                               |
| `allowShallow` | `boolean` | `false`         | Allow running in shallow clones (`fetch-depth > 0`) instead of throwing an error. |

## License

MIT
