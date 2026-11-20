# github-core-clone-01 — Entry Behavioural Specification

**Purpose.** A complete, checkable specification for building the entry (the forge) so a
builder never has to re-read the grader. Every claim cites the grader source as
`file:line` (paths relative to the kit directory
`~/workspace/make-fun/github-core-clone-01-kit/`, grader sources under
`program/env/src/`). Line numbers are the lines in the kit as delivered; where a claim
spans a range, the range is given.

**Sources read in full:** `checks-git.ts` (1150 lines), `checks-rest.ts` (1250),
`checks-graphql.ts` (1318), `checks-mcp.ts` (1002), `wire.ts` (1305), `manifest.ts`
(540), `main.ts` (1060), `export.ts` (235), `bench.ts` (877), `calibration.json`,
`git-client.ts` (2144), `rest-client.ts` (493), `graphql-client.ts` (331),
`mcp-client.ts` (795), `starter/main.ts`, `starter/app.ts`, plus `RULES.txt` for the
determinism rule and the viewer-identity question (the env sources alone do not state
it — see §2).

**No implementation code is in this file.** It is a specification only.

---

## 0. Score overview — what is at stake

120 conformance checks, 1 point each, in 7 groups (`manifest.ts:60-72`):

| Group | Checks | What it proves |
|---|---|---|
| `git` | 30 | smart-HTTP clone/fetch/push, pack protocol |
| `repos` | 15 | REST v3 repos, branches, commits, contents |
| `issues` | 15 | REST v3 issues, comments, labels |
| `pulls` | 20 | REST v3 pull requests, files, merge |
| `graphql` | 20 | GraphQL v4 documents gh / github-mcp-server send |
| `mcp` | 15 | MCP endpoint, tools, REST parity (also the agent column) |
| `protocol` | 5 | status/auth/JSON discipline shared by all surfaces |
| **Total** | **120** | |

Scoring (`manifest.ts:26-38, 300-330`):

- `feature = round(600 * passed / 120)` — max 600.
- `agent = round(200 * passed_mcp / 15)` — the MCP group counted a second time; max 200.
- `perf` = sum over 4 workloads of `round(clamp(25 - 12.5*log2(t_ms / T_ref_ms), 0, 50))`
  — max 200. `score = feature + agent + perf`, integer 0..1000.
- Tie-break: `perf_p50_us` ascending = geometric mean of the four workloads' p50_ms,
  in microseconds, rounded (`manifest.ts:474-486`); then earlier receipt.
- A check that throws, times out, or is never reached scores 0; a timeout is recorded
  with detail `"deadline"` (`main.ts:556-586`). **No conformance pass/fail bit ever
  reads a clock** (`checks-git.ts:1-14`, `checks-rest.ts:1-12`); only the benchmark
  times anything.
- Per-check timeouts are clamped to 5,000–15,000 ms (`manifest.ts:198-206`,
  `wire.ts:330-336`); git checks declare 5,000–15,000 ms, REST checks run through a
  client clamped to 1,000–5,000 ms (`checks-rest.ts:287`), GraphQL 8,000–15,000 ms
  (`checks-graphql.ts:1245-1266`), MCP 3,000 ms per request
  (`mcp-client.ts:40`, `checks-mcp.ts:158-162`).

Run order (`main.ts:614-618`): `[...GIT_CHECKS, ...restChecks(), ...restProtocolChecks(),
...GRAPHQL_CHECKS, ...MCP_CHECKS]` — one at a time, never overlapping. Checks are
independent and may run in any order (`checks-git.ts:14-20`); each creates its own
deterministically named fixtures, so **no fixture may be assumed to pre-exist** — the
entry starts empty every trial.

---

## 1. Lifecycle — the entry <-> env wire (`wire.ts`, `main.ts`, `starter/`)

### 1.1 Entry startup (what the entry must do)

From `starter/main.ts:1-104` (keep as-is; the lifecycle is not scored, the server is)
and `wire.ts:44-50`:

1. Read `MAKEFUN_ENV_URL` (e.g. `http://store:8080`). Absent → exit 1 at once.
2. Bind an **ephemeral port**: `server.listen(0)`. **Never bind 8080** — the env owns it.
3. `POST $MAKEFUN_ENV_URL/register` with JSON body `{"port": N}` (`wire.ts:148-152`,
   `REGISTER_PATH='/register'`). First register wins: first → HTTP 200 `{"ok":true}`;
   a later register → HTTP 409 `{"ok":false,"error":"already_registered"}` and does
   **not** move the base URL (`wire.ts:230-244`). Unparsable body → 400; wrong
   method → 405; body > 65,536 bytes → 400 (`wire.ts:120-128, 230-244`;
   `main.ts:295-343`). Extra keys in the register body are ignored
   (`wire.ts:186-192`).
4. Poll `GET $MAKEFUN_ENV_URL/done` until `{"done":true}`, then **exit 0**.
   The env answers at once (`{"done":false}` while running; answered within 1,000 ms,
   never held open — `wire.ts:256-268`). Poll with exponential backoff 250 ms → 2,000 ms
   cap, 30 s per-request timeout (`wire.ts:256-268`; `starter/main.ts:31-33, 66-82`).
   Never exit before `done:true`. On 409 from register, keep polling like any other
   (`starter/main.ts:55-64`).

### 1.2 Env boot check — what the entry must answer (`main.ts:620-652`, `wire.ts:296-306`)

- `GET /healthz` → **200 `{"ok":true}`**, called **twice**, within
  `HEALTHZ_BUDGET_MS = 10,000 ms`, inside an overall `BOOT_BUDGET_MS = 20,000 ms`
  (`wire.ts:296-306`). No register before the boot budget → boot failure: every
  check 0, `working=0`, export still written (`main.ts:18-21, 700-712`).
- `/healthz` takes **no auth** (`starter/README.md`).

### 1.3 Env phases and budgets (`wire.ts:288-312`, `main.ts:1-42`)

| Phase | Budget |
|---|---|
| boot | 20,000 ms (`BOOT_BUDGET_MS`) |
| conformance | 240,000 ms (`CONFORMANCE_BUDGET_MS`) |
| benchmark | 240,000 ms (`BENCHMARK_BUDGET_MS`) |
| export | 30,000 ms (`EXPORT_BUDGET_MS`) |
| trial wall budget | 900 s (`TRIAL_WALL_BUDGET_SEC`); env internal deadline = wall − 90,000 ms margin (`DEADLINE_MARGIN_MS`, `wire.ts:312-326`) |

At the internal deadline, unrun checks are recorded 0 with `"deadline"`, the export is
written anyway, `/done` answers true, and the env exits 5 s later if not SIGTERMed
(`main.ts:34-42, 700-760`). A SIGTERM at any point still writes an export
(`main.ts:28-30, 800-850`).

### 1.4 Env endpoints the entry talks to (for completeness; the entry is the client)

- `POST /register`, `GET /done` only; anything else → JSON 404
  `{"ok":false,"error":"not_found","message":"no route …"}` (`main.ts:295-360`).
- Env ready file: `<state>/ready` =
  `{"schema":"github-core-clone-01/ready/v1","host":…,"port":…}` — written by the env,
  not the entry (`wire.ts:380-400`).

### 1.5 Export / manifest format — what the scorer reads (entry does NOT write this)

The **env** writes the export; the entry must not write it. Included so the builder
understands what is scored (`export.ts:1-35`, `wire.ts:560-660`):

- `<stateDir>/export/state.json` — `{version:1, working:0|1, checks:{<id>:0|1 × 120},
  counts:{total:120, passed:N, byGroup:{<group>:{total,passed}}}, perfTiers:{push:0,
  clone:0, read:0, write:0}, notes?:[string]}`. Canonical JSON (keys sorted at every
  depth) + one trailing newline. `perfTiers` in state.json is **always all 0** (the
  static table; measured tiers live only in perf.json) so replays are byte-identical
  (`export.ts:36-48`). `working = 1` only when boot succeeded AND ≥1 check passed
  (`wire.ts:700-704`). A worse export never replaces a better one on disk
  (`export.ts:150-175`).
- `<stateDir>/export/perf.json` — `{version:1, calibrated:bool,
  workloads:[{name, rounds:[ms…], p50_ms, p99_ms, ops, points:0..50, error?}],
  tiers:{…}, points:{…}, perf_p50_us, points_total:0..200, notes:[…]}`
  (`wire.ts:600-640`). Failed/unrun workload: `p50_ms = p99_ms = 1e9`, points 0
  (`bench.ts:118-130`).
- Boot failure export: all checks 0, `working:0`, note
  `"no entry registered before the boot deadline"` (`wire.ts:646-660`,
  `export.ts:100-104`).

---

## 2. Identity and authentication — READ THIS FIRST

### 2.1 The one credential

- Every API call carries `Authorization: Bearer <token>` where the token is the
  entry's own `MAKEFUN_SHOP_TOKEN` environment variable
  (`wire.ts:88-90, TOKEN_ENV='MAKEFUN_SHOP_TOKEN'`; `rest-client.ts:36-40`;
  `graphql-client.ts:1-14`; `mcp-client.ts:24-30`).
- The entry must accept requests bearing exactly that token and reject requests
  without it with **401 + `{"message": string}`** (see §2.3). The token value is
  **never logged and never echoed** (`checks-mcp.ts:44`).

### 2.2 The viewer login — the entry must derive it from the fixed seed

**This is the single most load-bearing fact in the whole spec.** The suite addresses
repositories by the scenario viewer's login, e.g. `POST /user/repos` then
`GET /repos/{scenario.viewer.login}/{name}` (`checks-rest.ts:120-140, 380-420`),
`viewer.login` in GraphQL (`checks-graphql.ts:838-846`), and MCP setup resolves the
owner via `GET /api/v3/user` falling back to the scenario viewer
(`checks-mcp.ts:432-437`). The entry therefore **must serve under exactly the
scenario viewer's login** — it cannot invent its own.

The scenario is **not** trial-specific: it is built by `wire.ts: buildScenario()`
(`wire.ts:1200-1305`) from the **fixed** constant
`SCENARIO_SEED = 0x6a09e667f3bcc909n` (`wire.ts:716-720`), using only pure generators
(FNV-1a-64 + splitmix64 + xorshift64* — `wire.ts:724-820`). The same seed in any
process yields the same scenario, so the entry can (and must) reimplement
`buildScenario()` or hard-code its outputs. Verified by running the grader's own
`buildScenario()` in this kit:

| Field | Value (derived, fixed for every trial) |
|---|---|
| viewer login | **`adaiversen`** |
| viewer name | `ada iversen` |
| viewer email | `adaiversen@example.invalid` |
| viewer id | 1000 |
| teammate login | `quinnkeller` (id 1001) |
| stranger login | `olgabauer` (id 1002) |
| org | `faint-meadow-org` |
| scenario repos[0] | `amber-thistle` (id 5000, owner `adaiversen`, `defaultBranch: "main"`, `private: false`, description `"the tooling behind the thing"`) |
| labels | `bug, enhancement, documentation, question, good first issue, help wanted` |
| seed hex | `6a09e667f3bcc909` |

Derivation (for a reimplementation — `wire.ts:1030-1200`):
`users = generateUsers(scenarioRng('users'), 12)`; `viewer = users[0]`;
`stranger = users[2]`; `org` from `scenarioRng('org')`; repos from
`generateRepos(scenarioRng('repos.viewer'), viewer.login, 30, 5000)`.
**Do not** use the practice `reference/scenario.json` files — they contain only
`{schema, competition, scenario_seed, purpose, k, t, seed}` (the instance seed), not
the scenario data.

Consequences for the entry:

- `GET /api/v3/user` must return `{"login":"adaiversen", …}` for the bearer token
  (MCP `resolveOwner`, `checks-mcp.ts:432-437`; shape otherwise unchecked — return
  at least `login`, plus `id:1000`, `name`, `email` for safety).
- GraphQL `viewer { login }` must return `"adaiversen"`
  (`checks-graphql.ts:838-846`).
- Repositories created via `POST /user/repos` belong to `adaiversen`; every
  `/repos/adaiversen/<name>` route must find them.
- Any owner other than `adaiversen` (in particular `olgabauer`) → **404, never 403**
  (`checks-rest.ts:60-64, 700-712`; `RULES.txt` wire contract). This applies even
  when a repo of the same name exists under `adaiversen`.

### 2.3 Auth rules per surface

| Situation | Expected |
|---|---|
| REST, no token | **401** `{"message": string}` — `checks-rest.ts:676-680` (`repos.unauthorized`: GET a private repo anonymously), `protocol.error-message` (`checks-rest.ts:1218-1232`) |
| REST, valid token, repo under another owner | **404** `{"message": string}` (`repos.foreign-token`) |
| GraphQL, no token | **401** — `checks-graphql.ts:1150-1158` (`graphql.unauthenticated`: POST `/api/graphql` with `withoutToken()` client) |
| MCP `tools/call`, no `Authorization` header | **401** — `checks-mcp.ts:960-982` (`mcp.auth-required`; auth is decided before tool existence, so 401 even for an unknown tool name) |
| Git smart HTTP | The git client sends `Authorization: Bearer <token>` on **every** git request **except** it is only set when `this.token` is truthy (`git-client.ts:1336-1352`); no git check tests an unauthenticated git request. Accept the token when present; behaviour for a missing git token is **untested — accept it** (do not 401 git requests; the checks never send one without a token and a 401 would only risk breaking setup). |
| Wrong token (a token ≠ `MAKEFUN_SHOP_TOKEN`) | **Ambiguous — untested.** No check sends a wrong token. Recommended: treat any token ≠ the env token as unauthenticated (401). Do not invent a second user. |

### 2.4 What the entry must NOT do

- Never require `X-RateLimit-*` headers — explicitly not required
  (`checks-rest.ts:64-66`).
- Never serve HTML for an API error; every REST reply is `application/json`
  (`checks-rest.ts:60-66`).
- Never 403 for a foreign owner; it is 404 (`checks-rest.ts:60-64`).

---

## 3. Data model and store

The entry holds one in-memory (or file) store, shared by **all four surfaces** —
git, REST, GraphQL and MCP must read/write the **same objects** (MCP
`rest-parity`, `checks-mcp.ts:920-960`; GraphQL create/close/merge verified via REST,
`checks-graphql.ts:1000-1150`). There is no UI and no persistence requirement across
trials (fresh server each trial, `checks-rest.ts:6-10`).

### 3.1 Entities and fields

**Repository** — created only via `POST /api/v3/user/repos` (a git push **cannot**
invent a repository — `checks-git.ts:16-20`, `git-client.ts:2068-2110`).
Fields the checks read: `name` (string, exact), `private` (boolean, echoed),
`description` (string), `default_branch` (string, non-empty; must be `"main"` —
see §3.2), `id` (REST repo object must carry a stable `id` — required by MCP
`rest-parity`, `checks-mcp.ts:936-944`; type unchecked, number recommended),
`full_name` (`"owner/name"` — MCP `rest-parity` parses it if present,
`checks-mcp.ts:926-934`; include it), `owner`/`login` forms where applicable.
GraphQL also needs a numeric `databaseId` (positive integer, stable) and an opaque
global `id` (see §7).

**Branch / ref** — a named pointer `refs/heads/<name>` → commit SHA-1 (40 lowercase
hex). Default branch `main`. Created via git push or `POST /git/refs`.
Read via `GET /branches` (`[{name, commit:{sha}}]`) and via git ls-refs.

**Commit** — a git object: `{tree, parents[], author, committer, message}`.
SHA-1 = `SHA1("commit <len>\0" + bytes)` (`git-client.ts:319-332`). The checks build
commits themselves and push them; the entry must store them byte-exactly and return
them byte-exactly on clone/fetch. Commits the entry itself creates (REST contents
PUT, PR squash merge, GraphQL fixture path) must be valid git commits with a real
tree; their message must equal the requested message (REST checks assert the exact
message string, `checks-rest.ts:640-660`).

**Blob / tree / tag** — git objects, SHA-1 over `"<type> <len>\0" + bytes`.
Trees: entries `{mode, name, oid}` sorted git-style (directory names compared as if
suffixed `/` — `git-client.ts:399-410`); file mode `100644`, directory mode `40000`
(`checks-git.ts:640-690`). Annotated tags: `{object, type:"commit", tag, tagger,
message}` (`git-client.ts:439-464`).

**Issue** — per-repo counter starting at 1, incrementing by 1
(`checks-rest.ts:880-890`). Fields: `number` (int ≥1), `title` (string, echoed
exactly), `body` (string, echoed exactly), `state` (`"open"`|`"closed"`),
`labels` (array of `{name}` objects; label objects also carry `color` on creation),
`id` (stable, required by MCP parity — `checks-mcp.ts:948-956`), plus creation
order (insertion order = creation order; used for sort tests). GraphQL adds
`state` as `OPEN`/`CLOSED` and an opaque global `id` ≠ the plain number.

**Issue comment** — `id` (int ≥1), `body` (echoed exactly), attached to an issue
(`checks-rest.ts:1000-1030`).

**Label** — `name` (non-empty string), `color` (string; creation sends
`color:"ededed"`). Must be created via `POST /labels` before an issue may carry it;
an issue naming an unknown label → **422** (`checks-rest.ts:150-156, 1030-1040`).

**Pull request** — per-repo counter starting at 1, incrementing by 1 (same
numbering space as issues? **Ambiguous** — see §11.2; the checks create issues and
PRs in separate repos, so either implementation passes, but GitHub shares one
counter. Recommended: one shared counter per repo, as GitHub does).
Fields: `number`, `state` (`"open"`|`"closed"`), `title`, `body`, `head:{ref, sha}`,
`base:{ref, sha}`, `merged` (boolean), `merged_at` (non-empty string after merge),
`merge_commit_sha` (the merge commit SHA-1). GraphQL: `headRefName`, `baseRefName`,
`mergeable` (`MERGEABLE`|`CONFLICTING`|`UNKNOWN`), `merged`, `state`
(`OPEN`/`CLOSED`/`MERGED`).

**File / contents** — a path → blob mapping at a given ref, with a content SHA-1
(the blob's git SHA-1) and a commit SHA-1 per change.

### 3.2 Seeding — the suite seeds everything itself

- **No pre-seeded data.** The entry starts empty. Every check creates its repos via
  `POST /api/v3/user/repos`, its first commit via `PUT /contents` (which an unborn
  repository accepts — `checks-rest.ts:400-420`) or via git push, its branches via
  `POST /git/refs`, its issues/PRs via REST (`checks-rest.ts:6-12`).
- **Default branch is `main`** for every scenario repo (`wire.ts:742`,
  `DEFAULT_BRANCH='main'`) and every fixture branch is created against it. The
  entry's `POST /user/repos` must report `default_branch:"main"` (checks read it
  back and then use it as the base — `checks-rest.ts:420-440`; GraphQL fixture uses
  `repo.defaultBranch` = `"main"`; MCP setup defaults to `"main"` when the field is
  empty, `checks-mcp.ts:440-448`). A repo with no commits is "unborn": git
  advertisement lists **zero** `refs/*` refs and clone transfers zero objects
  (`checks-git.ts:530-548`).
- **Repo-name construction the checks use** (so the builder can predict collisions):
  REST repos are `<scenario.repos[0].name>-<check-slug>` = `amber-thistle-<slug>`,
  truncated to 100 chars (`checks-rest.ts:330-340`); git repos are
  `gitconf-<slug>` under the viewer (`checks-git.ts:236-246`); GraphQL repos are
  `amber-thistle-graphql` and `amber-thistle-graphql-pages`
  (`checks-graphql.ts:560-580`); MCP repos are `mcp-<seed8>-<part>`
  (`checks-mcp.ts:140-150`); bench repos are literally `bench-push`,
  `bench-clone`, `bench-read`, `bench-write` (`bench.ts:136-142`). All under
  `adaiversen`.
- **Creation order inside a check** (the pattern to support): create repo (REST) →
  first commit (PUT contents on the unborn repo, or git push of a root commit) →
  branch (POST /git/refs or PUT contents with `branch`) → commit on branch →
  issue/PR. The entry must support a `PUT /contents` on a repo whose default branch
  has no commit yet, creating the branch at that commit.

---

## 4. Git conformance checks — all 30 (`checks-git.ts`)

Setup harness (applies to every git check, `checks-git.ts:228-330`): a fresh repo
`gitconf-<slug>` is created via REST `POST /api/v3/user/repos`; the client builds
commits/trees/blobs locally (SHA-1, author `"ada iversen <adaiversen@example.invalid>"`,
timestamps = scenario commit `epochSec` + revision, timezone `+0000` — the commit
bytes are therefore fully determined); it pushes only objects the server's advertised
tips do not already reach (`pushRefs`, `checks-git.ts:262-300`); a push is judged by
its `report-status` (`unpack ok` + per-ref `ok`/`ng`).

Timeouts: 5,000–15,000 ms per check (declared in each `define(...)`).

| # | Check id | Timeout | Exact expectation |
|---|---|---|---|
| 1 | `git.advertise-v2` | 5,000 | `GET /{o}/{r}.git/info/refs?service=git-upload-pack` with `Git-Protocol: version=2` → protocol **2**; capabilities must include **`fetch`** and **`ls-refs`**; `object-format`, if present, must be `sha1` (`checks-git.ts:392-414`). |
| 2 | `git.advertise-receive-pack` | 5,000 | receive-pack advertisement is protocol **0**; lists `refs/heads/main` at the pushed tip; capabilities must include **`report-status`, `side-band-64k`, `delete-refs`** (`checks-git.ts:416-432`). |
| 3 | `git.advertise-headers` | 5,000 | All three info/refs answers are HTTP 200 with the exact content type: v0 upload-pack `application/x-git-upload-pack-advertisement`, v2 upload-pack the same, receive-pack `application/x-git-receive-pack-advertisement`. First data pkt-line: v0 upload-pack `# service=git-upload-pack` (or `version 2` is also accepted for the v0 request — see note below); receive-pack `# service=git-receive-pack`; v2 request `version 2` (a v0 answer to the v2 request is tolerated here — `git.advertise-v2` owns that failure) (`checks-git.ts:434-462`). |
| 4 | `git.unknown-repo-404` | 5,000 | info/refs for a missing repo → **404** on **both** services; a known repo still answers 200 afterwards (server stays up) (`checks-git.ts:464-476`). |
| 5 | `git.ls-refs` | 8,000 | v2 `ls-refs` with `peel`+`symrefs`: `refs/heads/main` at the 2nd commit; a `HEAD` entry with `symref-target: refs/heads/main`; `refs/tags/v1` at the tag object with `peeled:` = the tagged commit (`checks-git.ts:478-508`). |
| 6 | `git.ls-refs-prefix` | 8,000 | v2 `ls-refs` honours `ref-prefix`: `refs/heads/` returns only heads (incl. `main` at tip); `refs/tags/` only tags (incl. `v1`); a non-matching prefix returns **0 refs** (`checks-git.ts:510-528`). Filtering must be server-side (the client checks `rawRefs`) |
| 7 | `git.clone-empty` | 8,000 | Fresh repo (no refs): advertisement lists no `refs/*` refs; `clone` transfers **0 objects** and a **null/0-byte pack**; HEAD may be unborn → `refs/heads/main` (`checks-git.ts:530-548`). |
| 8 | `git.push-first-commit` | 8,000 | Push root commit to unborn `refs/heads/main` (`old=ZERO`): `unpack ok`, report `ok`; afterwards ls-refs shows `main` at tip and `HEAD` symref → `refs/heads/main` (`checks-git.ts:550-562`). |
| 9 | `git.clone-object-hashes` | 12,000 | Full clone of a 3-commit chain: every cloned object's SHA-1 recomputes to its id; tip present; reachable closure complete; no reachable object missing (`checks-git.ts:564-586`). |
| 10 | `git.clone-blob-bytes` | 12,000 | Every cloned blob (incl. a ~4,096-byte blob) is byte-identical to the pushed bytes; all reachable objects present and identical (`checks-git.ts:588-604`). |
| 11 | `git.clone-tree-entries` | 12,000 | Cloned root tree entries = the distinct top-level path segments, sorted; nested directory entry mode **`40000`**; nested tree entries correct; all trees byte-identical (`checks-git.ts:606-640`). |
| 12 | `git.clone-commit-bytes` | 12,000 | Tip commit bytes byte-exact; exactly 1 parent = previous tip; message = pushed message (with trailing `\n`); author and committer lines contain `"<epochSec> +0000"` and the viewer email `adaiversen@example.invalid` (`checks-git.ts:642-664`). |
| 13 | `git.clone-annotated-tag` | 10,000 | Annotated tag object byte-identical; `object`=tip, `type=commit`, `tag=v1`, tagger contains viewer email; ls-refs `peel` gives `refs/tags/v1` → tag object, peeled → tip (`checks-git.ts:666-682`). |
| 14 | `git.fetch-incremental` | 12,000 | After cloning tip1, push tip2, fetch with `wants=[tip2], haves=[tip1]`: delivers tip2 and exactly the new reachable objects; **must not** re-send tip1 or any object reachable from tip1 (`checks-git.ts:684-706`). |
| 15 | `git.fetch-nothing-new` | 10,000 | Fetch with `wants=[tip], haves=[tip]` (tip already held): **0 objects** delivered (a pack with no entries is acceptable) (`checks-git.ts:708-718`). |
| 16 | `git.fetch-shallow-depth1` | 12,000 | Depth-1 clone of a 3-commit chain: tip present and byte-identical; parent and grandparent **absent**; tip's tree and its blobs present; `shallow-info` names the tip (`checks-git.ts:720-738`). |
| 17 | `git.fetch-shallow-deepen` | 12,000 | Depth-1 clone, then fetch `depth:2` with `haves=[tip], shallow=[tip]`: delivers the parent commit byte-identical with its tree; grandparent absent; shallow boundary moves — either `shallow` names the parent **or** `unshallow` names the tip (`checks-git.ts:740-760`). |
| 18 | `git.fetch-shallow-new-tip` | 12,000 | Depth-1 clone, push a new tip, fetch new tip at depth 1 with `haves=[old tip]`: new tip delivered; old tip, its parent and the already-held parent **not** re-sent (`checks-git.ts:762-780`). |
| 19 | `git.push-update-ref` | 10,000 | Fast-forward push `tip→second`: `unpack ok`, report `ok`; ls-refs and a fresh clone see the new tip (`checks-git.ts:782-794`). |
| 20 | `git.push-create-branch` | 10,000 | Push `old=ZERO, new=tip` to `refs/heads/feature`: report `ok`; advertised and visible in a clone (`checks-git.ts:796-808`). |
| 21 | `git.push-delete-branch` | 10,000 | Delete `refs/heads/feature` (`new=ZERO`): report `ok`; ref gone from ls-refs; `main` intact; repo still clonable (`checks-git.ts:810-824`). |
| 22 | `git.push-non-fast-forward` | 10,000 | Push a sibling commit (same parent, different tip) with `old=<current tip>`: **still unpacks ok**, but report is `ng refs/heads/main non-fast-forward` — reason string must be exactly **`non-fast-forward`**; ref does not move; server stays healthy (info/refs 200); clone sees the unchanged tip (`checks-git.ts:826-846`). |
| 23 | `git.push-mixed-report` | 12,000 | One push with two commands — one fast-forward (`main`), one non-fast-forward (`side`): `unpack ok`; report has **exactly 2 lines**: `ok refs/heads/main`, `ng refs/heads/side non-fast-forward`; only `main` advances, `side` stays (`checks-git.ts:848-878`). |
| 24 | `git.push-delete-tag` | 10,000 | Delete `refs/tags/v1` (`new=ZERO`): report `ok`; tag gone from ls-refs; `main` untouched (`checks-git.ts:880-892`). |
| 25 | `git.push-100-files` | 15,000 | One commit with **100 files** (distinct paths, some nested) pushes and clones back byte-exactly: every path resolvable through the cloned trees, every blob byte-identical (`checks-git.ts:894-930`). |
| 26 | `git.pack-integrity` | 12,000 | Fetch with `parse:false`: a pack is delivered; trailer SHA-1 verifies; header count == parsed entries == unique objects; **pack version 2 or 3**; every object recomputes (`checks-git.ts:932-950`). |
| 27 | `git.pack-deltas` | 15,000 | 4 revisions of a ~20,000-byte file, then clone: all objects verify. Title says "when the server sends them" — **deltas are optional**: a server that sends plain (non-delta) objects passes, because the check only verifies the resolved objects (`checks-git.ts:952-968`). |
| 28 | `git.sideband-framing` | 12,000 | Fetch response: every pkt-line ≤ **65,520** bytes; packfile section is valid sideband — band 1 = pack data, band 2 = progress, band 3 = error (any band-3 fails); reassembled band-1 bytes form a pack whose trailer verifies; at least one sideband packet (`checks-git.ts:970-1006`). |
| 29 | `git.push-sideband-report` | 12,000 | Push report arrives demuxed from sideband band 1 (requires the server to have advertised `side-band-64k` for receive-pack); `unpack ok`; ref `ok`; progress bytes counted separately (`checks-git.ts:1008-1018`). |
| 30 | `git.repo-survives-errors` | 15,000 | After a 404 (missing repo), a refused non-fast-forward push, and a malformed POST body (`zzzznot-a-pkt-line` to `git-upload-pack` — **any** HTTP status / error is acceptable for the malformed POST itself, it is not asserted), the server still serves info/refs 200, `main` exists, and a clone is intact and hash-verified (`checks-git.ts:1020-1052`). |

Note on `git.advertise-headers` v0 line: the check accepts either `# service=git-upload-pack`
or `version 2` as the first data line of the v0-requested advertisement
(`checks-git.ts:448-452`) — but a v2 advertisement to a v0 request would fail
`git.advertise-v2`'s sibling expectations elsewhere, so serve the preamble for v0
requests and `version 2` for v2 requests.

---

## 5. REST v3 checks — repos (15), issues (15), pulls (20), protocol (5)

Common wire rules for **every** REST reply (`checks-rest.ts:60-66`,
`rest-client.ts:1-40`):

- `Content-Type: application/json` (a charset parameter is allowed; `application/vnd.github+json`
  and `+json` also count as JSON per `rest-client.ts:150-156`). **Never HTML** — neither
  a `text/html` content type nor a body starting with `<`.
- Every reply carries a **non-empty `X-GitHub-Request-Id`** header
  (`checks-rest.ts:1180-1200`). Any unique-per-request value is fine (deterministic
  values derived from the request are safest for replay; see §10).
- Error bodies are JSON objects `{"message": <non-empty string>, ...}` — the exact
  message text is **never asserted**, only that it is a non-empty string
  (`checks-rest.ts:322-326`).
- No `X-RateLimit-*` header is required.
- Requests carry `Accept: application/vnd.github+json` and
  `Content-Type: application/json` when they have a body; the server may ignore
  `Accept`.
- Malformed JSON request body → **400** `{"message": string}` (`protocol.malformed-body-400`,
  `checks-rest.ts:1170-1178`: `POST /api/v3/user/repos` with raw body `{"name":`).
- Unknown route under `/api/v3` → **404** `{"message": string}`, JSON, never HTML
  (`protocol.unknown-route-json-404`, `checks-rest.ts:1162-1168`).
- Auth: no token → 401 (see §2.3). Token is `Bearer <MAKEFUN_SHOP_TOKEN>`.
- Path encoding: owner/repo/file-path segments are percent-encoded by the client
  (`rest-client.ts:170-186`); a contents path keeps its `/` separators
  (`apiPath('repos', o, r, 'contents', 'docs/readme.md')` →
  `/api/v3/repos/<o>/<r>/contents/docs/readme.md`).
- Pagination: `Link: <url>; rel="next"` (also `prev`/`first`/`last` parsed, but only
  `next` is followed). The `next` URL must stay on the entry's own origin
  (`rest-client.ts:160-168`; `checks-rest.ts:600-630`). Query params `per_page`
  (and `page`, implied by the Link URL) are honoured.
- Repo names are ≤100 chars; owner/repo segments match
  `/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/` in the git client (`git-client.ts:1316-1324`).

### 5.1 repos (15) — `checks-rest.ts:560-760`

| # | Check id | Method / path | Expected status & body |
|---|---|---|---|
| 1 | `repos.pagination` | `POST /user/repos` ×30 (the 30 seeded names `amber-thistle`… — see §3.2), then `GET /user/repos?per_page=10` following `Link: rel="next"` | Creates accept **201**; a **422** is also accepted for a name an earlier group already created (the check then just requires the repo to be listable). Walk: ≤20 pages; every page ≤10 items; no repo repeated across pages; **all 30** names reachable; **≥3 pages** (`checks-rest.ts:580-630`). |
| 2 | `repos.root` | `GET /api/v3/` | **200**, JSON object (any shape — `looseObject`), header **`X-OAuth-Scopes`** present (starter sends `repo, read:org` — `starter/app.ts:38-42`) (`checks-rest.ts:636-642`). Note: `GET /api/v3` (no trailing slash) is served identically by the starter; the check uses `/api/v3/`. |
| 3 | `repos.meta` | `GET /api/v3/meta` | **200** `{"installed_version": <non-empty string>}` (`checks-rest.ts:644-648`). |
| 4 | `repos.create` | `POST /api/v3/user/repos` `{name, private:true, description}` then `GET /repos/{o}/{r}` twice | **201** `{name: <exact>, private: <boolean>}` and `private===true` in the body; GET **200** `{name, private:true, default_branch: <non-empty>}`; `default_branch` **identical on both reads** (`checks-rest.ts:650-666`). |
| 5 | `repos.not-found` | `GET /repos/{o}/amber-thistle-never-created` | **404** `{"message": string}` (`checks-rest.ts:668-674`). |
| 6 | `repos.patch` | `PATCH /repos/{o}/{r}` `{description: <alt>}` then GET | **200** `{description: <alt, exact>}`; GET afterwards shows the new description (`checks-rest.ts:676-682`). |
| 7 | `repos.delete` | `DELETE /repos/{o}/{r}` then GET | **204** (no body asserted); GET afterwards **404** `{"message": string}` (`checks-rest.ts:684-690`). |
| 8 | `repos.branches` | `POST /repos/{o}/{r}/git/refs` `{ref:"refs/heads/<branch>", sha}` then `GET /repos/{o}/{r}/branches` | POST **201** `{ref: "refs/heads/<branch>", object:{sha: <40-hex>}}`; GET **200** array of `{name: <non-empty>, commit:{sha: <40-hex>}}`; must list the new branch **and** the default branch; the new branch's `commit.sha` == the sha it was created at (case-insensitive compare) (`checks-rest.ts:560-580` helper `createBranch`, `632-646`). |
| 9 | `repos.commits` | `PUT /contents` on a branch (see §5.1 contents), then `GET /repos/{o}/{r}/commits?sha=<branch>` and `GET /repos/{o}/{r}/commits` | Branch query: **200** array of `{sha: <40-hex>, commit:{message: <string>}}`; must contain the branch commit with the **exact** message `"<seeded message> (commits)"`. Default (no `sha`): **200** array; must **not** contain that branch-only commit (`checks-rest.ts:648-668`). Order within the list is **not** asserted. |
| 10 | `repos.unauthorized` | `GET /repos/{o}/{r}` with **no token** | **401** `{"message": string}` (`checks-rest.ts:670-674`). |
| 11 | `repos.foreign-token` | `GET /repos/olgabauer/<name>` (same name, other owner) | **404** `{"message": string}` — never 403 (`checks-rest.ts:676-686`). |
| 12 | `repos.contents-create` | `PUT /repos/{o}/{r}/contents/<path>` `{message, content: <base64>}` (new file), then `GET` it | PUT **201** `{content:{sha: <40-hex>, encoding:"base64"}, commit:{sha: <40-hex>}}`; GET **200** `{type:"file", encoding:"base64", content: <base64>, sha: <40-hex>, size: <int ≥0>}`; `content` base64-decodes (ignoring newlines/whitespace) to the exact submitted bytes; `sha` == the PUT's `content.sha`; `size` == byte length of the content (`checks-rest.ts:688-700`, helpers `putContent`/`getContent` at `440-480`). |
| 13 | `repos.contents-directory` | `PUT` 3 files under `<dir>/` (`seed.txt`, `one.txt`, `two.txt`), then `GET /repos/{o}/{r}/contents/<dir>` | **200** **array** (not an object) of `{type: "file"\|"dir", name: <non-empty>, path: <non-empty>, sha: <40-hex>}`; must list all three names (`checks-rest.ts:702-716`). |
| 14 | `repos.contents-stale-sha` | `PUT` update with the current `sha`, then `PUT` again with the **old** `sha` | First update: **200 or 201** accepted, and the returned `content.sha` must **change**. Stale update: **409** `{"message": string}` (`checks-rest.ts:718-726`). |
| 15 | `repos.contents-delete` | `DELETE /repos/{o}/{r}/contents/<path>` `{message, sha}` then GET | **200** `{commit:{sha: <40-hex>}}`; GET afterwards **404** `{"message": string}` (`checks-rest.ts:728-736`). |

Contents details (from the helpers, `checks-rest.ts:400-480`):

- `PUT /contents/{path}` request body: `{message: string, content: <base64>, branch?: string,
  sha?: string}`. Create (no `sha`, file absent) → **201**; update (with current `sha`) →
  **200** (201 also accepted by the helpers — `contentCommit(..., [200, 201])` — but the
  contract header says 201 create / 200 update, `checks-rest.ts:30-34`; implement exactly
  that). Response shape: `{content:{sha, encoding:"base64"}, commit:{sha}}`.
- `PUT /contents` on an **unborn repo** (no commits) must succeed and create the default
  branch (`prepareRepo`, `checks-rest.ts:406-424`). With `branch` given, the commit goes
  on that branch (creating the branch from the default tip if needed — MCP setup relies
  on this fallback, `checks-mcp.ts:470-490`).
- `GET /contents/{path}`: file → the object shape above; directory → array shape above.
  Optional `?ref=<branch-or-sha>` reads that ref (`getContent`, `checks-rest.ts:462-480`).
  Missing file → **404** `{"message": string}` (asserted after delete; also used by the
  stale-sha flow).
- The `content.sha` is the **blob SHA-1** of the file bytes; the `commit.sha` is the new
  commit's SHA-1. The commit's tree must contain the file at that path with that blob,
  and the commit must be reachable from the branch — the REST checks verify this
  indirectly (contents round-trip, `repos.commits`, PR files/merge-content), and the git
  checks verify it directly when the same repo is cloned (GraphQL fixture pushes via
  git into a repo whose base commit came from REST contents — `main.ts:446-520`).
- `DELETE /contents/{path}` body `{message, sha}`; the file is removed and a commit is
  made on the default branch (or the `branch` given, if any — untested).

### 5.2 issues (15) — `checks-rest.ts:738-1040`

Fixture per check (`prepareIssueRepo`, `checks-rest.ts:600-620`): fresh repo + label
created via `POST /labels` `{name: <label>, color:"ededed"}` → **201** `{name}`.

| # | Check id | Request | Expected |
|---|---|---|---|
| 1 | `issues.create` | `POST /issues` `{title, body, labels:[<label>]}` | **201** `{number: int ≥1, title, body, state:"open", labels: [{name}]}` (`checks-rest.ts:738-744`). |
| 2 | `issues.create-title-body` | same, no labels | **201**; `title` and `body` echo **exactly** (`checks-rest.ts:746-752`). |
| 3 | `issues.create-labels` | `POST /issues` with an existing label | **201**; response `labels[].name` includes the label (`checks-rest.ts:754-760`). |
| 4 | `issues.numbers-increment` | create two issues in one repo | Second `number` == first `number` + 1 (`checks-rest.ts:762-768`). |
| 5 | `issues.list-open` | create open + closed issue; `GET /issues?state=open&per_page=100` | **200** array of issue shape; open issue present; **every** listed issue has `state:"open"` (`checks-rest.ts:770-780`). |
| 6 | `issues.list-open-excludes-closed` | close one issue; `GET /issues?state=open` | Closed issue absent from the list (`checks-rest.ts:782-788`). |
| 7 | `issues.list-sort-asc` | create a, b, c; `GET /issues?state=open&sort=created&direction=asc&per_page=100` | All three present; positions strictly increasing a<b<c (`checks-rest.ts:790-800`). |
| 8 | `issues.list-sort-desc` | same with `direction=desc` | Positions strictly decreasing: c<b<a, i.e. newest first (`checks-rest.ts:802-812`). |
| 9 | `issues.list-shape` | `GET /issues?state=open&per_page=10` | **200** array; every item matches the full issue shape (`checks-rest.ts:814-822`). |
| 10 | `issues.get-one` | `GET /issues/{n}` | **200** issue shape; `number`, `title`, `body` all match the created issue (`checks-rest.ts:824-834`). |
| 11 | `issues.patch-close` | `PATCH /issues/{n}` `{state:"closed"}` | **200** `{number, state:"closed"}` (`checks-rest.ts:836-842`). |
| 12 | `issues.patch-close-persists` | close, then `GET /issues/{n}` | Still `state:"closed"` (`checks-rest.ts:844-852`). |
| 13 | `issues.comment-create` | `POST /issues/{n}/comments` `{body}` | **201** `{id: int ≥1, body: <exact>}` (`checks-rest.ts:854-866`). |
| 14 | `issues.comments-list` | POST a comment, then `GET /issues/{n}/comments` | **200** array of `{id: int ≥1, body: string}`; contains the posted comment by `id` **and** exact body (`checks-rest.ts:868-886`). |
| 15 | `issues.bad-label` | `POST /issues` `{labels:["<label>-not-a-label"]}` | **422** `{"message": string}` (`checks-rest.ts:888-892`). |

Issue shape (asserted everywhere, `checks-rest.ts:560-570`):
`{number: int ≥1, title: string, body: string, state: "open"|"closed",
labels: [{name: non-empty string}]}`. Extra fields are allowed (the shape checker only
requires the listed props — `rest-client.ts:300-360`). `state` filter values: `open`,
`closed` (and `all` is used by MCP setup, `checks-mcp.ts:600-620` — support it).
`sort=created` + `direction=asc|desc` must order by creation (insertion) order.
Default list behaviour with no query params is **not** asserted for issues (checks
always pass `state` and usually `per_page`); default to `state=open`, creation order.

### 5.3 pulls (20) — `checks-rest.ts:1042-1250`

Fixture per check (`preparePull`, `checks-rest.ts:520-545`): fresh repo with an initial
contents commit on `main`; branch `<branchName>-<slug>` created at the initial commit
via `POST /git/refs`; one (or more) file commit(s) on the head branch via
`PUT /contents` with `branch`; then `POST /pulls {head, base, title, body}` →
**201** pull shape. Head branch changes a file to different content than base
(`variantPath` gives it a new path, e.g. `docs/readme-<slug>.md`).

Pull shape (asserted everywhere, `checks-rest.ts:486-496`):
`{number: int ≥1, state: "open"|"closed", title: string, body: string,
head:{ref: non-empty string, sha: <40-hex>}, base:{ref: non-empty string, sha: <40-hex>}}`.
Extra fields allowed; `merged`, `merged_at`, `merge_commit_sha` are asserted
additionally after a merge (see below).

| # | Check id | Request / setup | Expected |
|---|---|---|---|
| 1 | `pulls.create` | GET the created PR | **200** pull shape; `state:"open"`; `head.ref` == head branch; `base.ref` == default branch (`checks-rest.ts:1042-1052`). |
| 2 | `pulls.create-body` | GET the created PR | `title`/`body` echo exactly (`checks-rest.ts:1054-1062`). |
| 3 | `pulls.create-head-sha` | GET the created PR | `head.sha` == head branch tip commit SHA-1 (`checks-rest.ts:1064-1072`). |
| 4 | `pulls.create-base-sha` | GET the created PR | `base.sha` == base (default) branch tip at creation (`checks-rest.ts:1074-1082`). |
| 5 | `pulls.get-one` | `GET /pulls/{n}` | **200** pull shape; `number` and `title` match (`checks-rest.ts:1084-1092`). |
| 6 | `pulls.files-list` | `GET /pulls/{n}/files` | **200** array of file shape; lists the changed path; its `status` ∈ {`added`,`modified`,`changed`}; `additions` ≥ 1 (`checks-rest.ts:1094-1120`). |
| 7 | `pulls.files-shape` | `GET /pulls/{n}/files` | Non-empty array; **every** item matches `{filename: non-empty, status: non-empty, additions: int ≥0, deletions: int ≥0, changes: int ≥0}` (`checks-rest.ts:1122-1130`). |
| 8 | `pulls.files-multiple` | PR changing two files | Both filenames listed (`checks-rest.ts:1132-1142`). |
| 9 | `pulls.merge-status` | `PUT /pulls/{n}/merge` `{merge_method:"squash"}` | **200** (status only) (`checks-rest.ts:1150-1156`). |
| 10 | `pulls.merge-body` | same | **200** `{merged:true, sha: <40-hex>, message: <string>}`; `sha` is a 40-hex commit id (`checks-rest.ts:1144-1150, 1158-1162`). |
| 11 | `pulls.merge-closes` | GET PR after merge | **200** `{state:"closed", merged:true, merged_at: <non-empty string>}` (`checks-rest.ts:1164-1176`). |
| 12 | `pulls.merge-commit-on-default` | `GET /commits?sha=<base>` after merge | Merge commit SHA-1 appears in the base branch's commit list (`checks-rest.ts:1178-1186`). |
| 13 | `pulls.merge-content-on-default` | `GET /contents/<changed-path>?ref=<base>` after merge | Content base64-decodes to the head branch's file bytes (`checks-rest.ts:1188-1194`). |
| 14 | `pulls.merge-commit-sha` | GET PR after merge | `merge_commit_sha` == the merge reply's `sha` (case-insensitive) (`checks-rest.ts:1196-1204`). |
| 15 | `pulls.merge-unknown` | `PUT /pulls/999999999/merge` | **404** `{"message": string}` (`checks-rest.ts:1206-1210`). |
| 16 | `pulls.merge-conflict` | Two branches from the same base commit, **both** modify the **same file** to **different** content; PR A merged first (200), then merge PR B | Second merge → **405** `{"message": string}` (`checks-rest.ts:1212-1226`). See §5.3.1 for the conflict rule. |
| 17 | `pulls.list-state-all` | One merged PR + one open PR; `GET /pulls?state=all&per_page=100` | **200** array; **both** numbers present (`checks-rest.ts:1228-1238`). |
| 18 | `pulls.list-default-open` | Same fixture; `GET /pulls` (no `state`) | **200** array; merged PR **absent**, open PR present — default state is open-only (`checks-rest.ts:1240-1250`). |
| 19 | `pulls.list-shape` | `GET /pulls?state=all&per_page=10` | Non-empty array; every item matches the pull shape (`checks-rest.ts:1252-1262`). |
| 20 | `pulls.get-unknown` | `GET /pulls/999999999` | **404** `{"message": string}` (`checks-rest.ts:1264-1268`). |

#### 5.3.1 Merge semantics (the part a builder must get exactly right)

- Merge is **squash**: `PUT /pulls/{n}/merge` with body `{merge_method:"squash"}`.
  The merge must create **one** new commit on the **base (default) branch** whose
  tree contains the head branch's changed files (the squash content), whose parent
  is the base tip. That commit's SHA-1 is the merge `sha`, `merge_commit_sha`, and
  it must appear in `GET /commits?sha=<base>` and its file content must read back
  via `GET /contents/<path>?ref=<base>`.
- After merge: PR `state:"closed"`, `merged:true`, `merged_at` non-empty string.
  (GraphQL additionally requires `state` to read as `MERGED` in the v4 enum sense
  only where it checks `merged:true` + `state:"closed"` over REST — see §7.12.
  The REST `state` after merge is `"closed"`.)
- **Conflict rule** (the only conflict case tested): two PRs whose head branches
  both changed the **same path** relative to the same base, to **different**
  contents. After the first is merged (its content now on base), the second merge
  must be refused with **405**. Implementation: a three-way merge of head into base;
  if any path is modified on both sides with different resulting bytes (and neither
  side equals the base), the PR is conflicted. `mergeable` in GraphQL must reflect
  this (`MERGEABLE` / `CONFLICTING` / `UNKNOWN` — see §7.9).
- Unknown PR number → **404** (both GET and merge).
- Merging an already-merged/closed PR is **untested**; recommended: 405 (or 422 —
  either is untested; pick 405 for consistency with "cannot merge").

### 5.4 protocol (5) — `checks-rest.ts:115-130` (restProtocolChecks list) and the implementations at the end of the file

| # | Check id | Expected |
|---|---|---|
| 1 | `protocol.content-type-json` | Six calls — `GET /api/v3/`, `GET /api/v3/meta`, `GET <repo>`, `GET <repo>/issues`, `GET` an unknown route, `GET <repo>` without a token — **every** reply has a JSON content type and a non-HTML body (`checks-rest.ts:1270-1288`). |
| 2 | `protocol.unknown-route-json-404` | `GET /api/v3/no-such-route/<prefix>` → **404** `{"message": string}`, no HTML (`checks-rest.ts:1290-1296`). |
| 3 | `protocol.malformed-body-400` | `POST /api/v3/user/repos` with raw body `{"name":` and `Content-Type: application/json` → **400** `{"message": string}` (`checks-rest.ts:1298-1304`). Applies to any JSON body endpoint: a body that is not valid JSON is 400, never a crash. |
| 4 | `protocol.request-id` | Four calls (root, repo GET, unknown route, anon repo GET) — **every** reply carries a **non-empty** `X-GitHub-Request-Id` (`checks-rest.ts:1306-1320`). |
| 5 | `protocol.error-message` | 404 (missing repo), 401 (no token), 422 (unknown label) bodies all carry a **string** `message` (`checks-rest.ts:1322-1336`). |

---

## 6. Git protocol details (`git-client.ts`)

### 6.1 Transport and endpoints

- Remote path: `/<owner>/<repo>.git` (`git-client.ts:1316-1330`). Owner/repo must
  match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/` and repo must not end in `.git`.
- `GET /<owner>/<repo>.git/info/refs?service=git-upload-pack` and
  `?service=git-receive-pack`.
- `POST /<owner>/<repo>.git/git-upload-pack` with
  `Content-Type: application/x-git-upload-pack-request`,
  `Accept: application/x-git-upload-pack-result`.
- `POST /<owner>/<repo>.git/git-receive-pack` with
  `Content-Type: application/x-git-receive-pack-request`,
  `Accept: application/x-git-receive-pack-result`.
- The client sends `User-Agent: makefun-git-client/1.0`,
  `Git-Protocol: version=2` **only** on upload-pack requests when it wants v2
  (`git-client.ts:1336-1352, 1394-1422`); for receive-pack and v0 it sends no
  `Git-Protocol` header (the `infoRefs` code passes version 2 only for upload-pack
  when the preference is not 0 — `git-client.ts:1394-1410`).
- The client sends `Authorization: Bearer <token>` when a token is configured
  (`git-client.ts:1348-1350`). It follows **no redirects** (`redirect: 'error'`).
- Non-200 on a POST is a hard client error (the check fails with the status); on
  info/refs a non-200 is returned raw so the check can assert 404
  (`git-client.ts:1394-1422`). **Missing repo → 404 on both info/refs services.**
- Default per-request timeout 8,000 ms (`git-client.ts:40`).

### 6.2 pkt-line framing (`git-client.ts:83-300`)

- One packet: 4 lowercase/uppercase hex ASCII bytes = total length including the
  4 header bytes, then the payload. `0000` = flush, `0001` = delim, `0002` =
  response-end. Max packet **65,520** bytes including header (`PKT_LINE_MAX`,
  `git-client.ts:34-38`); a packet over that is a protocol error on the client side,
  and the sideband check fails the entry if any response pkt-line exceeds it
  (`checks-git.ts:984-990`).
- Payloads are **text lines ending in `\n`** unless stated (pack data is binary
  inside sideband band 1).

### 6.3 Advertisement formats

**v0** (`git-client.ts:1067-1150` — the parser the entry must satisfy):

```
# service=git-upload-pack\n          <- first pkt-line (data), then a flush pkt-line
<oid> SP <ref> NUL <capabilities>\n   <- first ref line carries caps after NUL
<oid> SP <ref>\n
<oid> SP <ref>^{}\n                   <- peeled tag: oid of the peeled commit
0000
```

- Capabilities are space-separated `name` or `name=value` tokens after the NUL on
  the **first** ref line.
- Empty repo: the client parser skips a ref named exactly `capabilities^{}` and
  treats a `ZERO_OID` ref as `unborn` (`git-client.ts:1120-1140`). The standard git
  form is a single line `000…0 capabilities^{}\0<capabilities>` — serve that for an
  empty repo (the checks only require **no `refs/*` refs** and a successful clone
  of 0 objects; the `capabilities^{}` pseudo-ref is skipped by the parser).
- `HEAD`: the client reads the symref from the `symref=HEAD:refs/heads/main`
  capability (`git-client.ts:1130-1140`). Advertisement should include a `HEAD` ref
  line (oid = default-branch tip, or ZERO when unborn) plus the `symref` capability.
  The v0 ls-refs fallback returns the advertisement's ref list, so HEAD must be
  present there for `clone.head` to resolve.
- Peeled tags: a `refs/tags/v1^{}` line with the commit oid.

**v2** (`git-client.ts:1090-1110`):

```
version 2\n
<capability>\n            <- one per line, e.g. "fetch", "ls-refs", "object-format=sha1"
...
0000
```

- The first data pkt-line must be exactly `version 2` (after the optional
  `# service=` preamble handling — the parser skips a leading `# service=…` line,
  `git-client.ts:1074-1084`; the checks' `advertise-headers` accepts the v2 body
  starting with either the preamble or `version 2`, but the cleanest form is:
  pkt-line `# service=git-upload-pack\n`, flush, pkt-line `version 2\n`, capability
  lines, flush — matching real git. **However**, note the client parser treats the
  *first* line: if the first line is `# service=…` it is skipped and the next line
  must be `version 2`).
- `object-format`, if advertised, must be `sha1` — the client throws otherwise
  (`git-client.ts:1102-1106`). Advertising `object-format=sha1` is safe; omitting it
  is also safe (the check only fails a non-sha1 value).

**Capabilities the entry must advertise:**

| Service | Required (checked) | Recommended additionally |
|---|---|---|
| upload-pack v2 | `fetch`, `ls-refs` (check 1) | `object-format=sha1`; `fetch` value should list `shallow` (see §6.5) — the client parses `fetch`'s value as space-separated features (`git-client.ts:1600-1606`) |
| upload-pack v0 | `side-band-64k` (client **refuses** to fetch v0 without it — `git-client.ts:1740-1744`); `multi_ack` / `multi_ack_detailed` optional; `thin-pack`, `ofs-delta`, `shallow` as supported | `agent=…` optional |
| receive-pack v0 | `report-status`, `side-band-64k`, `delete-refs` (check 2) | `report-status-v2` **only if** the entry implements its option lines (the client prefers v2 when advertised — `git-client.ts:1960-1966` — and parses `option …` lines after each ref; safest is to advertise only `report-status`); `ofs-delta`, `agent=…` optional |

### 6.4 upload-pack v2 commands the suite uses

**`ls-refs`** (`git-client.ts:1476-1540`): request is pkt-lines
`command=ls-refs\n`, optional `agent=…\n`, optional `object-format=sha1\n`, `delim`,
then (client always sends unless disabled) `peel\n`, `symrefs\n`, `unborn\n` (only
if the advertisement's `ls-refs` value lists `unborn`), then `ref-prefix <prefix>\n`
per prefix, then `flush`. Response: one pkt-line per ref:
`<oid> SP <name>[ SP symref-target:<target>][ SP peeled:<oid>]\n`, or `unborn SP
<name>[ SP symref-target:…]` for unborn refs; terminated by flush. **HEAD must
appear as a ref named `HEAD` with `symref-target: refs/heads/main` when symrefs was
requested** (check 5). Peeled tags: the tag ref line carries `peeled: <commit-oid>`.
`ref-prefix` filtering is **server-side** (check 6 reads `rawRefs`).

**`fetch`** (`git-client.ts:1560-1700`): request pkt-lines `command=fetch\n`,
optional `agent=…`, `object-format=sha1`, `delim`, then `thin-pack\n` (client sends
unless `thinPack:false`), `no-progress\n` (unless disabled), `ofs-delta\n`
(always), optional `filter …\n` (only if the server advertised `filter`),
`want <oid>\n` per want, `have <oid>\n` per have, `shallow <oid>\n` per known
shallow boundary, `deepen <n>\n`, `deepen-since <n>\n`, `deepen-not <ref>\n`,
`done\n`, `flush`.
Response sections, each introduced by a pkt-line naming the section followed by
its lines, sections separated by `delim`/`flush` (`git-client.ts:1640-1700`):

```
acknowledgments\n   NAK\n | ACK <oid>\n | ready\n
shallow-info\n      shallow <oid>\n | unshallow <oid>\n
wanted-refs\n       <oid> SP <ref>\n
packfile\n          sideband pkt-lines (band 1 = pack bytes, band 2 = progress, band 3 = error)
```

- The client parser **throws** on an unexpected section name or a bad line in a
  section (`git-client.ts:1660-1700`). Sections the response does not need may be
  omitted entirely (the parser only enters a section when it sees its name line;
  a response consisting of just `packfile\n` + sideband packets + flush is valid
  for a full clone). For a fetch with haves, an `acknowledgments` section with
  `NAK` is the normal answer (the checks do not assert ACK/NAK contents, only the
  delivered objects).
- `shallow-info`: for a depth-limited fetch, emit `shallow <tip-oid>` for each new
  shallow boundary commit; for a deepen, emit `unshallow <oid>` for boundaries
  that are no longer shallow (check 17 accepts either `shallow` naming the parent
  or `unshallow` naming the tip).
- **Packfile section is sideband-framed**: each pkt-line's payload starts with one
  band byte (1 = pack data, 2 = progress text, 3 = fatal error) followed by data
  (`git-client.ts:1690-1700`; check 28). Pack bytes are the concatenation of all
  band-1 payloads. Progress (band 2) is optional. Never send band 3 unless the
  fetch genuinely fails.

**v0 fetch fallback** (`git-client.ts:1702-1872`): used only if the server answers
protocol v0 to the upload-pack advertisement. Request: `want <oid>[ SP <caps>]\n`
(first want carries `side-band-64k [multi_ack[_detailed]] [thin-pack] [no-progress]
[ofs-delta]`), `shallow <oid>\n`, `deepen <n>\n`, …, `flush`, then `have <oid>\n`…,
`done\n`, `flush` — **two sections** (the client comment at `git-client.ts:1780-1784`
warns a single section makes the server misread `done`). Response: pkt-lines that
are either sideband packets (band byte first) or bare lines `NAK`, `ACK …`,
`shallow …`, `unshallow …`. A v0 server without `side-band-64k` cannot be fetched
at all (client throws).

**`clone`** (`git-client.ts:1874-1940`): ls-refs (v2) or the v0 advertisement, then
one fetch. Wants: **all** `refs/heads/*` and `refs/tags/*` tips by default; with
`depth` or `singleBranch`, only the HEAD symref target's tip (falling back to the
first head). Empty repo → no fetch, 0 objects.

### 6.5 Shallow semantics (exact)

- `deepen 1` on a chain of length ≥1: deliver only the wanted tip commit, its tree
  and blobs; **not** its parents. `shallow-info` must name the tip as shallow.
- `deepen 2` from a depth-1 clone (haves=[tip], shallow=[tip]): deliver the parent
  commit + its tree/blobs; **not** the grandparent; boundary moves (see check 17).
- A shallow fetch of a new tip (haves=[old tip], shallow=[old tip], depth 1):
  deliver the new tip only; do not re-send the old tip or its history.
- The client sends `shallow <oid>` lines for boundaries it already knows, and
  requires the server to advertise `shallow` inside the `fetch` capability value
  for v2 (`git-client.ts:1596-1602`) and the `shallow` capability for v0
  (`git-client.ts:1752-1756`) — **advertise `fetch=shallow` (v2) / `shallow` (v0)
  or every shallow check fails in the client before the server is even asked**.
  (Check the exact spelling: the v2 capability line is `fetch` with value
  `shallow`, i.e. the advertisement line reads `fetch=shallow` — the client does
  `(capabilities.get('fetch') ?? '').split(' ')` and looks for `shallow` in it.)

### 6.6 receive-pack v0 flow (`git-client.ts:1941-2068`)

Request body = pkt-lined command list + packfile bytes:

```
<old> SP <new> SP <ref>[ NUL <capabilities>]\n     <- first command carries caps after NUL
<old> SP <new> SP <ref>\n
...
0000
<pack bytes>                                        <- present whenever any command creates/updates a ref,
                                                       even if the pack is empty (0 objects); ABSENT for a
                                                       delete-only command list
```

- Capabilities the client sends (when the server advertised them):
  `report-status-v2` (preferred) else `report-status`, `side-band-64k`,
  `ofs-delta`, `agent=makefun-git-client/1.0` (`git-client.ts:1958-1968`).
- The client sends the pack it built with `writePack` (plain objects, no deltas —
  `git-client.ts:882-900`); the server must accept a pack with **0 objects**
  (delete-only is the exception: no pack at all is sent then).
- The server must **unpack and store every object** in the pack (validating SHA-1s),
  then apply the commands **per ref, independently**:
  - create (`old = ZERO`): ref must not exist; set to `new`.
  - update: `old` must equal the current tip (the client always sends the true
    current tip, except in the refusal tests); the update must be a **fast-forward**
    (new commit is a descendant of old, or old is ZERO). **Non-fast-forward →
    refuse that ref only**, with reason `non-fast-forward`; other refs in the same
    push still apply (check 23).
  - delete (`new = ZERO`): requires the `delete-refs` capability; remove the ref.
  - **Unpack must succeed even when a ref is refused** (checks 22/23 assert
    `unpackOk === true` on a refused push — the pack is valid; only the ref
    update is refused).
- Response: `report-status` — with `side-band-64k`, the report is pkt-lined
  **inside sideband band 1** (`git-client.ts:2010-2040`); without sideband, the
  body is the pkt-lined report directly. Report lines (each `\n`-terminated,
  pkt-framed inside band 1 when sideband is on):

```
unpack ok\n
ok <ref>\n
ng <ref> <reason>\n        <- reason exactly "non-fast-forward" for a refusal
[option <name>[ <value>]\n]  <- only for report-status-v2, after its ref line
```

  The client parser **throws** on a report with no `unpack` line, a malformed `ng`
  line, or an unknown line (`git-client.ts:2042-2068`). An empty report (no bytes)
  parses to `null` — the checks treat that as failure ("no report-status").
- `Content-Type` of the response must be
  `application/x-git-receive-pack-result` (`git-client.ts:1460-1474`, `expectOk`).
- A push to a **non-existent repo** is untested for receive-pack (only info/refs
  404 is tested); recommended: the POST also 404s (the client would surface it as
  an error, which is the honest behaviour).

### 6.7 Object format and packfile format

- **SHA-1 only** (`GIT_OBJECT_FORMAT='sha1'`, `git-client.ts:42-44`). Object id =
  lowercase 40-hex SHA-1 of `"<type> <decimal-size>\0" + content`
  (`git-client.ts:319-332`).
- The entry may store objects loose, packed, or in memory — the checks cannot tell
  and do not care, **as long as** clone/fetch returns byte-exact objects. It must
  be able to **read packs the client sends**: `writePack` packs are version 2,
  plain zlib-deflated objects, no deltas, trailer = SHA-1 of all preceding bytes
  (`git-client.ts:857-900`).
- Packs the entry sends must be version **2 or 3** (`readPack` accepts only 2/3 —
  `git-client.ts:707-730`), with a correct trailer, a header count equal to the
  number of entries, and every entry's declared size equal to its inflated size.
  **Deltas are optional** (check 27 passes with plain objects); if the entry does
  emit deltas, they must be valid `OFS_DELTA` (type 6) or `REF_DELTA` (type 7)
  with resolvable bases — including thin-pack bases the client already holds
  (`readPack` resolves REF_DELTA bases from `haveObjects` — `git-client.ts:800-856`).
  The client always sends `thin-pack` and `ofs-delta` in fetch requests, so the
  server **may** send thin packs, but is not required to.
- **Do not** send objects the client already holds in an incremental fetch
  (checks 14/18 assert exact set equality on the new reachable set). The correct
  algorithm: reachable(new tips) − reachable(old tips ∪ haves), where reachability
  walks commit parents → trees → blobs, and tags peel to their target.
- Tree objects must be built with git's entry sort (directories as `name/`) and
  modes `100644` (file) / `40000` (dir). Executable `100755` and symlink `120000`
  are never sent by the suite and need not be produced (but must round-trip if
  pushed — the entry stores objects opaquely, so this is automatic if it never
  re-serialises trees it did not build).
- Commit objects the entry builds (REST contents, squash merge): format is
  `tree <oid>\n[parent <oid>\n…]author <name> <email> <epoch> +0000\ncommitter …\n\n<message>\n`
  (`buildCommit`, `git-client.ts:482-496`). Author/committer for entry-built
  commits is **not asserted** by any check (only the message is, for REST commits);
  use the viewer identity `ada iversen <adaiversen@example.invalid>` and a
  deterministic timestamp (see §10).

---

## 7. GraphQL v4 — all 20 checks (`checks-graphql.ts`)

Endpoint: `POST /api/graphql`, JSON body `{query: string, variables?: {...}}`
(and optionally `operationName`), `Authorization: Bearer <token>`,
`Content-Type: application/json`, `Accept: application/json`
(`graphql-client.ts:1-60, 230-280`). Response: JSON `{data: {...}, errors?: [...]}`.
**Rules that apply to every GraphQL response** (`graphql-client.ts:1-30`):

- A GraphQL-level failure (unknown field, bad argument) is **HTTP 200 with an
  `errors` array** — never an HTTP error — **except** unauthenticated → **401**
  (check 15).
- A successful response must carry a `data` object (a response with neither `data`
  nor `errors` is a parse error in the client — `graphql-client.ts:300-330`).
- Batching: a JSON **array** of operation objects in one body → a JSON **array** of
  per-operation `{data, errors}` bodies **in the same order** (check 18).
- Unknown repository → `data.repository = null` with **no errors** (check 17).

Fixture (built lazily, shared across the group's checks — `checks-graphql.ts:560-700`):
repo `amber-thistle-graphql` (created via REST, 201/200/422/409 all accepted);
base commit on `main` pushed via the **git fixture adapter** (`main.ts:446-540` —
the env pushes one commit per branch over smart HTTP, so the entry's git push must
work for the GraphQL PR checks to run at all); three head branches from the
scenario pulls; 3 open issues + 1 closed issue via REST; a second repo
`amber-thistle-graphql-pages` with exactly **7** issues for pagination.

### 7.1 The 20 checks

| # | Check id | Document / operation | Exact expectation |
|---|---|---|---|
| 1 | `graphql.viewer-login` | `query ViewerLogin { viewer { login } }` | **200**, no errors; `data.viewer.login === "adaiversen"` (`checks-graphql.ts:838-846`). |
| 2 | `graphql.repository-fields` | `query RepositoryFields($owner: String!, $name: String!) { repository(owner:$owner, name:$name) { id databaseId name owner{login} defaultBranchRef{name} viewerPermission hasIssuesEnabled } }` | `id` equals the id read from the fixture repo (stable); `databaseId` a positive integer, equal across reads; `name` == repo name; `owner.login` == `"adaiversen"`; `defaultBranchRef.name` == `"main"` (only asserted when the git adapter is installed — it always is in the real run); `viewerPermission` ∈ {`ADMIN`,`MAINTAIN`,`WRITE`,`TRIAGE`,`READ`}; `hasIssuesEnabled === true` (`checks-graphql.ts:848-872`). |
| 3 | `graphql.introspection-issue` | `query Issue_fields { Issue: __type(name:"Issue") { fields(includeDeprecated:true) { name } } }` | `__type("Issue").fields` non-empty and includes **`id, number, title, state, body`** (`checks-graphql.ts:874-884`). Note the **alias** `Issue:` — the response key is the alias, not `__type`. |
| 4 | `graphql.introspection-types` | `query PullRequestAndRepositoryFields { PullRequest: __type(name:"PullRequest") { fields(includeDeprecated:true){name} } Repository: __type(name:"Repository") { fields(includeDeprecated:true){name} } }` + `query SearchType_enumValues { SearchType: __type(name:"SearchType") { enumValues(includeDeprecated:true){name} } }` | PullRequest fields include **`id, number, headRefName, baseRefName, mergeable, state, merged, files`**; Repository fields include **`id, databaseId, name, nameWithOwner, owner, defaultBranchRef, viewerPermission, hasIssuesEnabled, issue, issues, pullRequests, pullRequest`**; SearchType `enumValues` non-empty and includes **`ISSUE`** (`checks-graphql.ts:886-908`). |
| 5 | `graphql.issues-open-order` | `query OpenIssues($owner,$name,$first: Int!) { repository { issues(first:$first, states:[OPEN], orderBy:{field:CREATED_AT, direction:DESC}) { nodes { number title state id } } } }` with `first:10` | ≤10 nodes; every node `state === "OPEN"`, has a string `title` and non-empty `id`; node numbers in **strictly descending** order; the closed fixture issue absent; all 3 open fixture issues present (`checks-graphql.ts:910-934`). Per `RULES.txt` GraphQL section, ties order by number DESC — with distinct creation times this is the same as creation DESC. |
| 6 | `graphql.issue-by-number` | `query IssueByNumber { repository { issue(number:$number) { number title state id body } } }` | Issue #1 (first open): `number` matches, `state === "OPEN"`, `title === "<seeded title> open 1"`, `body` == seeded body, `id` non-empty (`checks-graphql.ts:936-952`). |
| 7 | `graphql.create-issue` | `mutation IssueCreate($input: CreateIssueInput!) { createIssue(input:$input) { issue { number id } } }` with `input:{repositoryId, title:"<prefix> created over graphql", body}` | **200**, no errors; `number` positive int, `id` non-empty; then `GET /api/v3/repos/{o}/{r}/issues/{number}` → 200 with the same `number`, `title`, `state:"open"` (`checks-graphql.ts:954-970`). |
| 8 | `graphql.close-issue` | Create an issue via REST, read its global id via `IssueByNumber`, then `mutation IssueClose($input: CloseIssueInput!) { closeIssue(input:$input) { issue { number id state } } }` with `input:{issueId}` | `number` matches, `state === "CLOSED"`; REST GET afterwards shows `state:"closed"` (`checks-graphql.ts:972-990`). |
| 9 | `graphql.pull-requests-list` | `query PullRequests { repository { pullRequests(first:5) { nodes { number headRefName baseRefName mergeable state } } } }` | ≤5 nodes; the fixture PR present with `headRefName` == head branch, `baseRefName` == `"main"`, `state === "OPEN"`, `mergeable` ∈ {`MERGEABLE`,`CONFLICTING`,`UNKNOWN`} (`checks-graphql.ts:992-1012`). |
| 10 | `graphql.pull-request-files` | `query PullRequestFiles { repository { pullRequest(number:$n) { number files(first:10) { nodes { path } } } } }` | `number` matches; `files.nodes[].path` includes the changed file path (the head branch's file) (`checks-graphql.ts:1014-1032`). |
| 11 | `graphql.create-pull-request` | `mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input:$input) { pullRequest { number id state headRefName baseRefName } } }` with `input:{repositoryId, baseRefName:"main", headRefName:<createBranch>, title}` | `number` positive int, `id` non-empty, `state === "OPEN"`, head/base match; REST `GET /pulls/{number}` shows the same head/base refs (`checks-graphql.ts:1034-1058`). |
| 12 | `graphql.merge-pull-request` | `mutation MergePullRequest($input: MergePullRequestInput!) { mergePullRequest(input:$input) { pullRequest { number merged state } } }` with `input:{pullRequestId, mergeMethod:"SQUASH"}` | `merged === true`; REST GET afterwards: `merged === true`, `state === "closed"` (`checks-graphql.ts:1060-1076`). Merge method enum value is the string `"SQUASH"` in the variables. |
| 13 | `graphql.add-comment` | Create issue via REST, read its global id, then `mutation AddComment($input: AddCommentInput!) { addComment(input:$input) { commentEdge { node { id body } } } }` with `input:{subjectId, body}` | `commentEdge.node.body` == submitted body exactly, `id` non-empty; REST `GET /issues/{n}/comments` lists a comment with that body (`checks-graphql.ts:1078-1096`). |
| 14 | `graphql.invalid-field` | `query ViewerInvalidField { viewer { login noSuchFieldOnViewer } }` | **HTTP 200** with a non-empty `errors` array; at least one error message **contains the substring `noSuchFieldOnViewer`** (`checks-graphql.ts:1098-1110`). |
| 15 | `graphql.unauthenticated` | `query ViewerLogin` with **no token** | **HTTP 401** (`checks-graphql.ts:1112-1120`). |
| 16 | `graphql.node-repository` | `query NodeRepository($id: ID!) { node(id:$id) { id ... on Repository { name nameWithOwner } } }` | `node.id` == the repo's global id; `name` == repo name; `nameWithOwner` == `"adaiversen/<repo>"` (`checks-graphql.ts:1122-1134`). Requires inline-fragment (`... on Repository`) support. |
| 17 | `graphql.unknown-repository` | `RepositoryFields` with `name: "amber-thistle-graphql-missing"` | **200**, no errors; `data.repository === null` (`checks-graphql.ts:1136-1144`). |
| 18 | `graphql.batched-operations` | One HTTP body = JSON array `[ {query: ViewerLogin}, {query: Issue_fields} ]` (no variables) | **200**; response is an array of **2** entries, in order; first gives `viewer.login === "adaiversen"`; second gives a non-empty Issue fields list (`checks-graphql.ts:1146-1162`). |
| 19 | `graphql.global-id-stability` | `RepositoryFields` twice; `IssueByNumber` twice | Repo `id` identical across reads; repo `id` **≠ `String(databaseId)`** (must be opaque, not the plain numeric id); issue `id` identical across reads; issue `id` **≠ `String(number)`** (`checks-graphql.ts:1164-1184`). |
| 20 | `graphql.issues-pagination` | `query IssuesPage($owner,$name,$first: Int!, $after: String) { repository { issues(first:$first, after:$after) { nodes { number } pageInfo { hasNextPage endCursor } } } }` on the 7-issue repo, `first:5, after:null`, then `first:5, after:<endCursor>` | Page 1: exactly **5** nodes, `hasNextPage === true`, `endCursor` a non-empty string. Page 2: exactly **2** nodes, `hasNextPage === false`. No number on both pages; all 7 numbers are exactly the fixture's numbers (`checks-graphql.ts:1186-1220`). |

### 7.2 GraphQL executor requirements (derived from the documents above)

- **Variables**: string/int variables, inline enum lists (`states: [OPEN]`), inline
  input objects (`orderBy: {field: CREATED_AT, direction: DESC}`), null variables
  (`after: null`), operation names (`query ViewerLogin` etc.), and JSON-array
  batching (`checks-graphql.ts:36-60`).
- **Enums** the schema must know: `IssueState OPEN/CLOSED`,
  `MergeableState MERGEABLE/CONFLICTING/UNKNOWN`, `PullRequestState
  OPEN/CLOSED/MERGED`, `PullRequestMergeMethod MERGE/SQUASH/REBASE`,
  `RepositoryPermission ADMIN/MAINTAIN/WRITE/TRIAGE/READ`, `SearchType` (at least
  `ISSUE` in `enumValues`), `IssueOrderField CREATED_AT/UPDATED_AT/COMMENTS`,
  `OrderDirection ASC/DESC` (`checks-graphql.ts:54-60`).
- **Field selection**: only the fields the documents request need to be resolved,
  but `__type` introspection must list the fields in check 3/4 even if a field is
  never queried elsewhere (e.g. `Repository.issue`, `PullRequest.files` are listed
  in introspection and also used; `Issue.body` is used in check 6).
- **Aliases**: response keys are the alias when one is given (`Issue:`, `PullRequest:`,
  `Repository:`, `SearchType:`).
- **`__type` arguments**: `fields(includeDeprecated: Boolean)` and
  `enumValues(includeDeprecated: Boolean)` — accept the argument (value `true` in
  the documents); returning the same list regardless of the flag is fine.
- **Arguments on connections**: `issues(first, states, orderBy, after)`,
  `pullRequests(first)`, `files(first)`, `issue(number:)`, `pullRequest(number:)`,
  `repository(owner:, name:)`, `node(id:)`.
- **Mutations and their inputs**:
  - `createIssue(input: {repositoryId, title, body})` → `{issue:{number, id}}`.
    `repositoryId` is the repo's opaque global id.
  - `closeIssue(input: {issueId})` → `{issue:{number, id, state}}` with
    `state:"CLOSED"`.
  - `createPullRequest(input: {repositoryId, baseRefName, headRefName, title})` →
    `{pullRequest:{number, id, state, headRefName, baseRefName}}`. (No `body` in the
    input — the REST PR is created with an empty/absent body; the check does not
    assert the body.)
  - `mergePullRequest(input: {pullRequestId, mergeMethod})` →
    `{pullRequest:{number, merged, state}}`; `mergeMethod:"SQUASH"` must be accepted
    (and should squash-merge exactly as §5.3.1).
  - `addComment(input: {subjectId, body})` → `{commentEdge:{node:{id, body}}}`.
    `subjectId` is the issue's opaque global id.
- **Global ids**: opaque, stable, distinct per entity type. A practical scheme:
  base64 of `"Repository:<databaseId>"` / `"Issue:<repoDbId>:<number>"` /
  `"PullRequest:<repoDbId>:<number>"` / `"IssueComment:<id>"` — none of which equals
  the plain numeric id (check 19). `node(id:)` must resolve a repository id back to
  the repository (and return `null` for unknown ids — untested, but the honest
  behaviour).
- **Issue ordering**: `orderBy:{field:CREATED_AT, direction:DESC}` → numbers
  descending (creation order reversed); `states:[OPEN]` filters out closed issues.
  The default (no `orderBy`) order is **not** asserted except through pagination
  (page 1 then page 2 must partition the 7 issues in creation order — the natural
  reading is creation order ascending across pages; the check only asserts the
  partition and counts, not the internal order of each page).
- **Cursor**: `endCursor` must be an opaque non-empty string that resumes after the
  last node of the page; `hasNextPage` true iff more nodes remain. A practical
  scheme: base64 of the last returned issue number (or an offset).
- **Error messages**: for an unknown field, the error message must contain the
  field name verbatim (`noSuchFieldOnViewer`). For other GraphQL errors, any
  message is fine (only check 14 inspects one).
- **REST cross-surface**: every GraphQL mutation's effect must be visible over
  REST immediately (checks 7/8/11/12/13 all re-read via REST).

---

## 8. MCP — all 15 checks (`checks-mcp.ts`)

Endpoint: `POST <baseUrl>/mcp`, JSON-RPC 2.0 over Streamable HTTP
(`mcp-client.ts:1-60`). Two protocol eras are accepted; the entry may implement
**either** (the suite negotiates):

### 8.1 Modern era (2026-07-28) — preferred

- No handshake. Every request declares its revision in
  `_meta['io.modelcontextprotocol/protocolVersion']` (and a plain `_meta.protocolVersion`)
  and mirrors it in the `MCP-Protocol-Version` header (`mcp-client.ts:24-60, 660-700`).
- `server/discover` is a **mandatory** RPC returning a `DiscoverResult`:
  `supportedVersions` = non-empty list of `YYYY-MM-DD` revision strings,
  `capabilities`, `serverInfo` — the server identity may live in
  `_meta['io.modelcontextprotocol/serverInfo']` **or** top-level `serverInfo`
  (`mcp-client.ts:280-300, 520-542`). `serverInfo.name` and `.version` must be
  non-empty strings; `capabilities.tools` must be present (an object — `{}` is
  enough; check 1 asserts `isRecord(capabilities.tools)`).
- Every POST carries `Accept: application/json, text/event-stream`,
  `Content-Type: application/json`, `Mcp-Method` (mirrored method name) and, for
  `tools/call`, `Mcp-Name` headers (`mcp-client.ts:660-700`). The entry should
  **not** reject requests for missing/extra mirrored headers — the client always
  sends them; the entry only needs to answer the RPC.
- Response: one JSON body **or** one request-scoped SSE stream whose final data
  frame is the JSON-RPC response (`mcp-client.ts:736-795`). Plain JSON is simpler
  and fully accepted (the client parses a JSON body directly; `sse:false`).
- If the server cannot serve the declared revision, answer JSON-RPC
  `-32022` (UnsupportedProtocolVersionError) with `data.supported` listing the
  revisions it does support — the client retries with one of them
  (`mcp-client.ts:432-470`). (Simpler: accept `2026-07-28` and every legacy
  revision, and never emit -32022.)
- Per-request deadline: **each request must answer inside 3 seconds**
  (`MCP_DEFAULT_TIMEOUT_MS = 3_000`, `mcp-client.ts:40`; `RULES.txt` MCP section).

### 8.2 Legacy era (2025-11-25 and earlier) — acceptable alternative

- `server/discover` answers **404**, or JSON-RPC **-32601** (Method not found), or
  any other refusal **before a working initialize handshake** — the discover check
  then passes with detail "pre-discover revision" (`checks-mcp.ts:560-590`).
- `initialize` with `{protocolVersion: <one of 2025-11-25, 2025-06-18, 2025-03-26,
  2024-11-05>, capabilities:{}, clientInfo:{…}}` → result
  `{protocolVersion: <the revision the server chose>, capabilities:{…},
  serverInfo:{name, version}}`; the client tries revisions newest-first and
  accepts the echo, stopping at the first non-`-32602` answer
  (`mcp-client.ts:471-520`). Then `notifications/initialized` (a notification, no
  id) — answer with any 2xx/empty response; the client ignores a failure here.
- Optional `Mcp-Session-Id` header: if the server hands one out in a response, the
  client sends it on later requests (`mcp-client.ts:677-700`). The entry may omit
  sessions entirely.
- `close()`: the client sends `DELETE /mcp` with `Mcp-Session-Id` when a session
  exists (`mcp-client.ts:604-630`) — answer 2xx/4xx harmlessly; it is best-effort.
- Parse-error status differs by era: modern → **HTTP 400** with JSON-RPC -32700;
  legacy → HTTP **200** with -32700 is also accepted (`checks-mcp.ts:700-720`).
  Implement 400 (modern) unless the entry is deliberately legacy-only.

### 8.3 The 15 checks

Setup (per check, `checks-mcp.ts:400-560`): repos are created over REST
(`POST /user/repos`, then `GET /repos/{o}/{r}` to learn `default_branch`); files
via `PUT /contents` (with and without `branch`); branches via
`POST /git/refs` **or** a contents write on the branch (the setup tries refs first,
then contents — so the entry must support **both** routes); branch tips read via
`GET /git/refs/heads/{branch}` **or** `GET /branches/{branch}` (either shape is
accepted — the setup reads `object.sha`, `sha`, or `commit.sha` — so implement at
least one of these two GET routes; `GET /branches/{branch}` returning
`{name, commit:{sha}}` is the simplest, matching the REST branches shape).

| # | Check id | Call | Exact expectation |
|---|---|---|---|
| 1 | `mcp.initialize` | `server/discover` (modern) or `initialize` (legacy) via `connect()` | `serverInfo.name` and `.version` non-empty strings; `capabilities.tools` present (an object) (`checks-mcp.ts:560-580`). |
| 2 | `mcp.server-discover` | `server/discover` probe | Modern: `supportedVersions` non-empty (all `YYYY-MM-DD`). Pre-discover: a 404, -32601, or any refusal **before a working initialize** passes as "pre-discover revision" (`checks-mcp.ts:582-600`). |
| 3 | `mcp.tools-list` | `tools/list` | **≥6 tools**; all six canonical tools present by name **or obvious alias** (see §8.4) — matched by exact name, alias, or **suffix, case-insensitive** (a server prefix such as `github__create_issue` is allowed) (`checks-mcp.ts:602-622`). |
| 4 | `mcp.tool-schemas` | `tools/list` | **Every** listed tool has a **non-empty `description`** and an `inputSchema` that is an object with `type === "object"` (`checks-mcp.ts:624-644`). |
| 5 | `mcp.create-issue` | `tools/call create_issue {owner, repo, title, body}` on a fresh REST-created repo | No JSON-RPC error, `isError` not true; then `GET /repos/{o}/{r}/issues?state=all&per_page=100` lists an issue with the **same title** (`checks-mcp.ts:646-668`). |
| 6 | `mcp.list-issues` | Create an issue via REST, then `tools/call list_issues {owner, repo, state:"open"}` | Result text (content blocks' `text`, plus `structuredContent` serialised) must contain the issue's **title** or a `"number": <n>` matching it (`checks-mcp.ts:670-694`). |
| 7 | `mcp.create-pull-request` | Prepare repo + base commit + head branch (REST), then `tools/call create_pull_request {owner, repo, title, body?, head, base}` | No error; REST `GET /pulls/{n}` (by number from the tool result, else by title/head in the list) shows `head.ref` == head branch and `base.ref` == base branch (`checks-mcp.ts:696-720`). |
| 8 | `mcp.merge-pull-request` | Create a PR via REST, then `tools/call merge_pull_request {owner, repo, pull_number}` | No error; REST `GET /pulls/{n}` shows `merged === true` (`checks-mcp.ts:722-746`). |
| 9 | `mcp.unknown-tool` | `tools/call` with name `mcp_no_such_tool_<tag>`, `{}` arguments | JSON-RPC error **-32602 or -32601**; **never HTTP 500** (`checks-mcp.ts:748-768`). |
| 10 | `mcp.parse-error` | POST the raw (truncated, invalid-JSON) body `{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"` | **HTTP 400** with JSON-RPC **-32700** (modern); HTTP 200 with -32700 is accepted only for a legacy-era server (`checks-mcp.ts:770-786`). |
| 11 | `mcp.missing-arguments` | `tools/call create_issue` with **no arguments** (`{}`) | Either `isError:true` in the tool result **or** JSON-RPC **-32602** (`checks-mcp.ts:788-808`). |
| 12 | `mcp.concurrent-calls` | Two concurrent `tools/call get_repo` with distinct string ids (`concurrent-left-<tag>`, `concurrent-right-<tag>`) for two different repos | Each answer's JSON-RPC `id` matches the id that was sent; neither answer is an error; each answer's result text names **its own** repo (`checks-mcp.ts:810-840`). The entry must be able to serve concurrent requests (no serialising lock that mixes up responses). |
| 13 | `mcp.tools-list-idempotent` | `tools/list` twice | The two tools arrays are **byte-identical** when JSON-stringified (`checks-mcp.ts:842-858`). Deterministic ordering; no timestamps/random ids in tool definitions. |
| 14 | `mcp.rest-parity` | `tools/call create_repo {owner?, name, description?, private?}` then `tools/call create_issue` in it | REST `GET /repos/{o}/{r}` → 200; the repo's REST `id` is present and **identical on two reads**; the issue's REST `id` is present, identical on two reads, and its `title` matches (`checks-mcp.ts:860-920`). |
| 15 | `mcp.auth-required` | `tools/call create_issue` with **no `Authorization` header** | **HTTP 401** (`checks-mcp.ts:922-940`). |

### 8.4 Tool contract (names, arguments, aliases)

Canonical tools (`checks-mcp.ts:60-80`) and their documented arguments
(`checks-mcp.ts:36-44`):

| Canonical name | Arguments (github-mcp-server's) | Aliases accepted (matched by normalised suffix too) |
|---|---|---|
| `create_repo` | `{name, description?, private?}` | `create_repository`, `repo_create`, `repos_create`, `repository_create` |
| `get_repo` | `{owner, repo}` | `get_repository`, `repo_get`, `repos_get`, `repository_get` |
| `create_issue` | `{owner, repo, title, body?}` | `issue_create`, `issues_create` |
| `list_issues` | `{owner, repo, state?}` | `issues_list`, `issue_list` |
| `create_pull_request` | `{owner, repo, title, head, base}` | `pull_request_create`, `pulls_create`, `create_pr`, `pr_create` |
| `merge_pull_request` | `{owner, repo, pull_number}` | `pull_request_merge`, `pulls_merge`, `merge_pr`, `pr_merge` |

- **Argument mapping** (`checks-mcp.ts:170-230`): the suite maps its documented
  argument names onto the tool's own `inputSchema.properties` by normalised name
  (lowercase, non-alphanumerics removed). It accepts many synonyms per argument —
  e.g. `owner` may be addressed as `owner_login`, `org`, `user`, `login`, …;
  `repo` as `repository`, `repo_name`, …; `head` as `head_ref`, `head_branch`,
  `source_branch`, `branch`, …; `pull_number` as `pr_number`, `number`, …; `title`
  as `issue_title`, `subject`, …; `body` as `description`, `content`, `text`, ….
  **If a tool's `inputSchema` has a `required` property the suite has no value
  for, the check fails naming that property** — so: keep `required` to exactly the
  documented arguments (and for `create_repo`, `name` only; the suite passes
  `owner` too, but a `required: ["owner"]` would also be fillable — safest is
  `required: ["name"]` for create_repo, and the documented required sets for the
  others). A property named `full_name` (or `repo_full_name` /
  `repository_full_name`) receives `"owner/repo"` when the schema has no separate
  `owner`/`repo` properties (`checks-mcp.ts:200-215`).
- **Tool results**: the suite reads a tool result's text blocks (`content[].text`
  for `type:"text"`) plus `structuredContent` if present, and parses the first JSON
  value it finds (`checks-mcp.ts:250-300`). For `create_issue` / `create_pull_request`
  / `merge_pull_request` it looks for a `number`/`pull_number` field; for
  `list_issues` it needs the title or `"number": N` in the text; for `get_repo` it
  needs the repo name in the text; for `create_repo` it reads `full_name` if
  present. **Safest result shape**: `content: [{type:"text", text: <JSON string of
  the created object>}]` **and** `structuredContent: <the same object>`. Include
  `number`, `title`, `full_name`/`name`, `owner`/`repo` where applicable.
- `tools/list` supports cursor pagination (`nextCursor`) in the client
  (`mcp-client.ts:580-597`) — the entry may return all tools in one page with no
  `nextCursor`.
- Tool calls use `params: {name, arguments: {...}}` (`mcp-client.ts:597-603`).
  `tools/call` with an unknown name → -32602/-32601 (check 9); with missing
  required arguments → `isError:true` or -32602 (check 11). A tool execution
  failure (e.g. creating an issue in a missing repo) should be `isError:true`
  with a text message, **not** a JSON-RPC error and not HTTP 500 — the checks
  treat `isError:true` as a failed call with the message as the detail.

---

## 9. Performance workloads (`bench.ts`, `manifest.ts`, `calibration.json`)

Four workloads, run **after** conformance, in order push → clone → read → write
(`bench.ts:760-877`). Each: **5 untimed warm-up operations**, then **3 timed
rounds**; the workload's time is the **median round** (nearest-rank percentile —
`bench.ts:170-185`). Setup (repo creation, history building) is inside the
workload's 60 s budget but **outside** every timed round. A workload that throws
or does not finish all rounds in budget scores **0** (its `p50_ms`/`p99_ms` become
the sentinel 1e9 — `bench.ts:118-130, 200-260`).

| Workload | Fixed work per round | Ops/round | T_ref (ms) | Notes for the builder |
|---|---|---|---|---|
| `push` | 200 **sequential** receive-pack pushes of a 1 KiB change to one repo (`bench-push`), each a new commit on `refs/heads/main` (advertisement + command list + pack, pre-built before timing) | 200 | **1640.82** | The entry's push path is timed end-to-end (HTTP + unpack + ref update). Keep per-push work O(changed objects), not O(repo size): never re-hash or re-walk the whole history per push. |
| `clone` | 50 **concurrent** shallow clones (depth 1) of a 200-commit repo (`bench-clone`), each stream checksum-verified, objects **not** parsed by the client | 50 | **266.941** | Concurrency matters: 50 simultaneous fetches. The pack for a depth-1 clone is tiny (tip commit + tree + blobs); serve it without walking all 200 commits. |
| `read` | 2,000 **sequential** `GET /api/v3/repos/{o}/bench-read/issues/{n}` on one warm keep-alive connection | 2,000 | **2759.715** | Pure REST read path. Must be fast per request (~1.4 ms at T_ref). Avoid per-request O(n) scans where n grows; an id-keyed lookup is the difference between 25 and 0 points. |
| `write` | 200 **sequential** `POST /api/v3/repos/{o}/bench-write/issues` | 200 | **348.965** | Issue creation path. Same warning as read. |

T_ref values are the medians of three house-reference runs on the production
cluster (`calibration.json: "workloads"` — push 1640.82, clone 266.941, read 2759.715,
write 348.965 ms; `manifest.ts:430-450` reads them into `T_REF_MS`).

Scoring formula per workload (`manifest.ts:452-468`):
`points = round(clamp(25 - 12.5*log2(t_ms / T_ref_ms), 0, 50))`.
At `t = T_ref` → 25; half of T_ref → 38 (37.5 rounds to 38); double → 13 (12.5
rounds to 13); quarter or less → 50; 4× or slower → 0. The reference forge itself
earns 100/200 at its own medians (`calibration.json: "consumer_state"`).

Workload construction details the entry must support (`bench.ts:340-560`):

- `push`: repo `bench-push` is deleted then re-created (DELETE then POST — the
  DELETE 404-when-absent is normal); payloads are pre-built packs of exactly 3
  objects (blob, tree, commit) per push, chained by parent; the first push creates
  the branch (`old=ZERO`). The entry must accept 615 sequential pushes (5 warm-up
  + 3×200) with strictly increasing commits.
- `clone`: repo `bench-clone` deleted/re-created; **one** push carrying all 200
  commits (600 objects in one pack) creates the history; then clones are
  `depth:1, parse:false, singleBranch:true` — the client verifies the pack
  checksum and that `packBytes > 0` and `refs.length > 0`.
- `read`: repo `bench-read` deleted/re-created; one issue created via REST; then
  2,000 GETs of that same issue. The same `RestClient` (undici pool) reuses the
  socket — **keep-alive matters**: the entry must support HTTP/1.1 keep-alive
  (Node's `http` server does by default; do not send `Connection: close`).
- `write`: repo `bench-write` deleted/re-created; 615 issue creations with
  distinct titles (`"<title> [bench N]"`).

Budgets: each workload 60,000 ms; the phase 240,000 ms total; the env's internal
deadline also caps it (`bench.ts:640-760`). The entry's own speed is the only
variable — there is no way to "pass" a workload except by being fast.

**House reference behaviour to beat** (`calibration.json`): the reference forge
(the baseline entry) passes 120/120 and its medians are the T_refs above. Its
`perf_p50_us` (geometric mean of the four p50s, µs) was 712,790–900,674 across the
three calibration runs (median-of-medians 805,899). To beat it on the tie-break,
the entry's geometric mean must be lower.

---

## 10. Determinism rules

From `RULES.txt` ("The determinism rule") and the env sources:

- **No wall clock in anything the entry sends or stores that a check reads**:
  never `Date.now()`, `new Date()`, or a timer reading in a request/response.
  Dates come from **`MAKEFUN_TRIAL_NOW`** (the instance's opening time, an env
  var the entry process receives). The env sources themselves never read a clock
  for data: scenario timestamps derive from `SCENARIO_EPOCH_SEC = 1_735_689_600`
  (2025-01-01T00:00:00Z) plus seeded offsets (`wire.ts:716-742`); bench commits use
  fixed epoch `1_700_000_000` (`bench.ts:160-166`); the GraphQL fixture commits use
  `FIXTURE_EPOCH_SEC = 1_735_689_600` (`main.ts:146-150`).
- **No unseeded randomness**: never `Math.random()` or a random UUID. Random
  choices draw from **`MAKEFUN_TRIAL_SEED`**. In practice the entry needs almost
  no randomness: ids should be **deterministic counters** (repo databaseId,
  issue/comment numbers, `X-GitHub-Request-Id` — e.g. a per-process counter, or a
  hash of method+path+counter). **Warning**: `X-GitHub-Request-Id` must be
  non-empty on every reply; a counter-based value is replay-safe.
- **One order**: the suite sends the entry one request at a time (except the
  benchmark's 50 concurrent clones and MCP's 2 concurrent calls). The entry's
  responses must not depend on completion order.
- **Replay**: a final trial runs twice (live, then replay from the cassette) and
  `state.json` must be byte-identical. Anything the entry returns that varies
  run-to-run (timestamps, random ids, unordered map iteration leaking into a
  response) breaks replay. Concretely: sort everything the entry emits that has
  no specified order (branch lists, directory listings, tools/list); use insertion
  order where the checks assert it (issues by creation, commits by ancestry).
- **Timestamps the entry emits**: `merged_at` must be a non-empty string
  (checks assert only non-emptiness). Use `MAKEFUN_TRIAL_NOW` (or a fixed
  constant derived from it) for it, not the wall clock. Issue/PR `created_at` /
  `updated_at` fields are **never asserted** by any check — safest is to omit
  them, or emit them from `MAKEFUN_TRIAL_NOW`. If emitted, they must be
  consistent with `sort=created` ordering (insertion order, not the timestamp
  value — the checks sort by creation, and the entry controls the order it lists).
- **Git commit timestamps for entry-built commits**: use a fixed epoch (e.g.
  `SCENARIO_EPOCH_SEC` or `MAKEFUN_TRIAL_NOW` parsed as seconds) with `+0000`.
  The checks never assert these timestamps, but the commit SHA-1s must be stable
  across live and replay runs — a wall-clock timestamp would change the SHA-1
  and break replay determinism of anything that reads the sha back (e.g. the
  squash-merge content check re-reads the file, not the sha — but the merge sha
  itself is returned and compared across two reads within one run, so it must at
  least be stable within a run).

---

## 11. Anything else a builder must know

### 11.1 Cross-cutting

- **Single Node 22 process, stdlib only, no dependencies** (`starter/package.json`:
  no dependencies; `node --experimental-strip-types main.ts`). No `git` binary in
  the trial pod, no internet (`starter/README.md`). The entry may write under
  `/tmp` only at runtime (repo mounted read-only at `/bot`).
- **Trailing slashes**: `GET /api/v3/` and `GET /api/v3` are both served by the
  starter (`starter/app.ts:38-42`); the checks use `/api/v3/`. For git paths, the
  client builds exact paths — do not redirect (the git client uses
  `redirect: 'error'`).
- **Case sensitivity**: owner/repo names, ref names, paths and logins are
  case-sensitive (all comparisons in the clients are exact, except SHA-1 hex
  comparisons which are case-insensitive — `checks-rest.ts:340-350` lowercases
  SHAs before comparing; the entry should emit lowercase hex always).
- **Default branch**: `main`, everywhere (see §3.2).
- **Empty-repo behaviour**: no refs advertised; clone = 0 objects; `PUT /contents`
  on an unborn repo creates the first commit (see §5.1).
- **HTTP methods**: unknown method on a known path is untested except
  `POST /register` vs other methods (env side). For the entry, an unsupported
  method on a REST route should answer 404 JSON (or 405 JSON — untested; 404 is
  the safer default given the unknown-route rule).
- **Response size**: the REST client truncates bodies past 1 MiB
  (`rest-client.ts:28-30`) — keep list responses paginated and small.
- **Keep-alive**: required for the read workload (see §9); Node's `http` server
  keeps connections alive by default.
- **Concurrency**: the clone workload fires 50 concurrent fetches and MCP fires 2
  concurrent tool calls; the entry must handle concurrent requests on one process
  without corrupting shared state (in-memory Maps with synchronous mutation per
  request are fine in Node; avoid read-modify-write across an `await`).

### 11.2 Ambiguities — stated explicitly, with the source quoted

1. **Issue vs PR numbering: shared or separate counters?** The checks create
   issues and PRs in separate repos and only assert `+1` within each kind
   (`checks-rest.ts:762-768` for issues; no equivalent PR increment check exists).
   GitHub uses one shared counter per repo. **Recommendation: one shared counter
   per repo** (an issue created after a PR gets the next number in the shared
   sequence). Either choice passes the current checks.
2. **Duplicate repo creation status.** `POST /user/repos` for an existing name:
   the pagination check accepts **201 or 422** (`checks-rest.ts:586-594`); the
   GraphQL fixture accepts 201/200/422/409 (`checks-graphql.ts:660-668`); the git
   `createRepo` helper accepts 201/200, or 422 when the body says "already exists"
   (`git-client.ts:2068-2110`); the bench `recreateRepo` deletes first, so it never
   hits a duplicate. **Recommendation: return 422 with `{"message": …already
   exists…}`** — it is accepted everywhere a duplicate can occur.
3. **Wrong-token behaviour.** No check sends a wrong token (see §2.3). Treat as
   401.
4. **Unauthenticated git requests.** No check sends one (see §2.3). Accept them
   (do not 401) — the git client always sends the token in practice.
5. **`GET /api/v3/user`.** No REST check calls it directly; MCP `resolveOwner`
   (`checks-mcp.ts:432-437`) calls it and falls back to the scenario viewer when
   it "refuses". Implement it returning `{"login":"adaiversen","id":1000,…}` —
   returning the wrong login here would break MCP setup (it would then address
   repos under the wrong owner).
6. **`GET /repos/{o}/{r}/git/refs/heads/{branch}` and `GET /repos/{o}/{r}/branches/{branch}`.**
   Not asserted by any REST check, but MCP setup reads a branch tip through
   either (`checks-mcp.ts:452-470`). Implement at least `GET /branches/{branch}`
   → `{name, commit:{sha}}` (404 when absent).
7. **Default `per_page` / default issue-list state.** The checks always pass
   `per_page` explicitly where it matters. GitHub's default is 30; any default
   passes the current checks. For `GET /issues` with no `state`, default to
   `open` (matches `GET /pulls` default-open, which **is** asserted).
8. **Issue/PR `created_at` ordering vs `sort=created`.** The checks assert
   creation order by position, not by any timestamp field. Keep an insertion
   sequence number per repo and sort by it.
9. **GraphQL `Repository.issues` default order / `orderBy` without `states`.**
   Only `states:[OPEN]` + `orderBy:{CREATED_AT,DESC}` is asserted (check 5) and
   cursor pagination without `orderBy` (check 20, partition only). Default order:
   creation ascending.
10. **GraphQL `viewerPermission` value.** Any of `ADMIN/MAINTAIN/WRITE/TRIAGE/READ`
    passes (`checks-graphql.ts:868-872`). Use `"ADMIN"` (the token owner owns the
    repo).
11. **MCP `create_repo`'s `owner` argument.** The suite passes `owner` in the
    semantic arguments (`checks-mcp.ts:880-900`), but a repo is always created
    under the token owner. Ignore a passed `owner` that equals the viewer; if it
    differs, the honest behaviour is to create under the viewer anyway (the
    check then reads `full_name` from the result to learn the real owner).
12. **Report-status-v2.** The client prefers it when advertised
    (`git-client.ts:1960-1966`). If the entry advertises it, it must emit valid
    `option …` lines (the client parses them). **Recommendation: advertise only
    `report-status`.**
13. **`X-GitHub-Request-Id` on the 204 DELETE response.** The request-id check
    (`checks-rest.ts:1306-1320`) does not call DELETE; the content-type check
    neither. Send the header on every response anyway, including 204s — it costs
    nothing.
14. **Trailing-slash / duplicate-slash handling on git paths.** The client builds
    exact paths; no check sends a malformed one. Do not normalise.
15. **`GET /api/v3/meta`'s `installed_version` value.** Any non-empty string
    passes. Use something stable like `"1.0.0"`.
16. **The `description` on `POST /user/repos` when omitted.** The checks always
    send one (except the GraphQL pages repo, which sends none —
    `checks-graphql.ts:700-712`). Default to `""`.
17. **`PUT /contents` update returning 200 vs 201.** Helpers accept both
    (`checks-rest.ts:440-460`); the contract header says 201 create / 200 update
    (`checks-rest.ts:30-34`). Implement 201/200 exactly.
18. **What a `DELETE /repos/{o}/{r}` does to git refs.** Untested beyond "GET is
    404 afterwards". Delete the repo and all its refs/objects; a later git
    info/refs for it should then 404 (consistent with `git.unknown-repo-404`).

### 11.3 Routes the entry must implement — consolidated checklist

```
GET  /healthz
GET  /api/v3/                                  (and /api/v3)
GET  /api/v3/meta
GET  /api/v3/user
GET  /api/v3/user/repos?per_page=&page=
POST /api/v3/user/repos
GET  /api/v3/repos/{o}/{r}
PATCH /api/v3/repos/{o}/{r}
DELETE /api/v3/repos/{o}/{r}
GET  /api/v3/repos/{o}/{r}/branches
GET  /api/v3/repos/{o}/{r}/branches/{branch}  (MCP setup; §11.2.6)
GET  /api/v3/repos/{o}/{r}/commits[?sha=]
POST /api/v3/repos/{o}/{r}/git/refs
GET  /api/v3/repos/{o}/{r}/git/refs/heads/{branch}  (MCP setup alternative)
GET  /api/v3/repos/{o}/{r}/contents/{path}[?ref=]
PUT  /api/v3/repos/{o}/{r}/contents/{path}
DELETE /api/v3/repos/{o}/{r}/contents/{path}
POST /api/v3/repos/{o}/{r}/labels
POST /api/v3/repos/{o}/{r}/issues
GET  /api/v3/repos/{o}/{r}/issues[?state=&sort=&direction=&per_page=&page=]
GET  /api/v3/repos/{o}/{r}/issues/{n}
PATCH /api/v3/repos/{o}/{r}/issues/{n}
POST /api/v3/repos/{o}/{r}/issues/{n}/comments
GET  /api/v3/repos/{o}/{r}/issues/{n}/comments
POST /api/v3/repos/{o}/{r}/pulls
GET  /api/v3/repos/{o}/{r}/pulls[?state=&per_page=&page=]
GET  /api/v3/repos/{o}/{r}/pulls/{n}
GET  /api/v3/repos/{o}/{r}/pulls/{n}/files
PUT  /api/v3/repos/{o}/{r}/pulls/{n}/merge
POST /api/graphql
POST /mcp
GET  /{o}/{r}.git/info/refs?service=git-upload-pack|git-receive-pack
POST /{o}/{r}.git/git-upload-pack
POST /{o}/{r}.git/git-receive-pack
*    anything else -> 404 {"message":"Not Found"} (JSON)
```

### 11.4 Check inventory (for the builder's own tally)

- git: 30 — §4 table.
- repos: 15 — §5.1. issues: 15 — §5.2. pulls: 20 — §5.3. protocol: 5 — §5.4.
- graphql: 20 — §7.1. mcp: 15 — §8.3.
- **Total: 120 checks.**

### 11.5 Files that define the behaviour (for audit)

- `program/env/src/checks-git.ts`, `checks-rest.ts`, `checks-graphql.ts`,
  `checks-mcp.ts` — the checks (what is scored).
- `program/env/src/git-client.ts`, `rest-client.ts`, `graphql-client.ts`,
  `mcp-client.ts` — the clients (the exact bytes the entry must accept/emit).
- `program/env/src/wire.ts` — lifecycle, scenario seed, export shapes.
- `program/env/src/manifest.ts` — groups, counts, scoring formula, T_ref slots.
- `program/env/src/main.ts` — run order, boot, GraphQL git fixture, deadlines.
- `program/env/src/bench.ts` — the four workloads.
- `program/env/src/export.ts` — export bytes and the never-worse rule.
- `program/env/src/calibration.json` — T_ref medians.
- `starter/main.ts`, `starter/app.ts` — lifecycle (keep) and the two starter routes.
- `RULES.txt` — determinism rule; viewer/token contract in prose; MCP/GraphQL
  prose that matches the checks (where RULES.txt and the checks differ, the
  **checks apply** — `RULES.txt:3-5`).
