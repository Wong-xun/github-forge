# github-forge

A standalone, GitHub-compatible git forge in one Node 22 process, stdlib only.
No UI, no git binary, no outside service: it serves from its own in-memory
store.

## Run it

```sh
node --experimental-strip-types main.ts
```

The program binds an ephemeral port, registers it with the environment at
`$MAKEFUN_ENV_URL`, and exits 0 when the environment says the trial is done
(`main.ts` is the starter lifecycle, kept as-is).

## Surface

| Route | What it is |
|---|---|
| `GET /healthz` | 200 `{"ok":true}`: the boot probe |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, squash merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over Streamable HTTP (revision 2026-07-28, legacy `initialize` handshake also accepted): `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` |
| `/<owner>/<repo>.git/...` | git smart HTTP: upload-pack protocol v2 (`fetch`, `ls-refs`, shallow), receive-pack v0 (`report-status`, `side-band-64k`, `delete-refs`) |
| anything else | 404 `{"message":"Not Found"}` |

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a request
without it is 401, and a repository belongs to the login the token names
(`adaiversen` in the trial scenario), so the same repository name under
another owner is 404, never 403.

## Layout

- `main.ts`: the entry <-> environment lifecycle. Keep as it is.
- `app.ts`: the HTTP server and router.
- `store.ts`: the shared store — repositories, git objects, issues, pull
  requests — plus tree/commit builders and reachability.
- `gitproto.ts`: pkt-line codec, packfile read/write, smart-HTTP handlers.
- `rest.ts`: the REST v3 handlers and the squash-merge implementation.
- `graphql.ts`: a small GraphQL parser and executor for the suite's documents.
- `mcp.ts`: the MCP JSON-RPC endpoint and its six tools.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): metadata and licence.

## Determinism

The entry never reads a wall clock or unseeded randomness in anything it
serves: entry-built commit timestamps and `merged_at` come from
`MAKEFUN_TRIAL_NOW` (falling back to a fixed epoch), ids are deterministic
counters, and every list it emits has a fixed order, so a replayed trial
produces the same export.
