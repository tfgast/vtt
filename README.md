# A Table of Dumb Objects

A virtual tabletop for one GM, built on one idea: every object on the table
is a bag of cells, cells hold literals or formulas, and rules attach to
space. A token, a sheet, a card with buttons, a fog zone and a dice tray are
all the same kind of thing, and an AI agent you bring yourself works on the
same table through an MCP server. The design and the formula language are in
[docs/](docs/); project conventions are in [CLAUDE.md](CLAUDE.md).

## Quick start

Prerequisites: Node 26 (the root `package.json` `engines`) and pnpm 10.32,
which `corepack enable` provides (the version is pinned in
`packageManager`).

In the repo root:

```sh
corepack enable
pnpm install
pnpm start tables/crypt.table.json
```

- `pnpm start <file>` runs in the repo root, so the path above is
  `<repo>/tables/crypt.table.json`. `tables/` is created if it is missing and
  is gitignored.
- A missing table file is created holding the GM board and the GM binder,
  stocked with the example templates. Add `--empty` for a table with no
  objects; it has no effect on an existing file.
- The UI is built first only when its build is missing or older than its
  sources; `--no-build` skips that check.
- Once the server is listening, the table opens in your browser (`$BROWSER`
  if set, else the platform's opener). If no browser can be opened, the
  terminal prints the address to open; the server keeps running.
- Ctrl+C in the terminal saves the table and stops the server.
- Running the same command again reopens the table. A tab left open from the
  previous run shows a banner offering Reload; press it to reconnect.

For your first session, follow [docs/FIRST-SESSION.md](docs/FIRST-SESSION.md).

## Attach an agent

The agent talks to the table through `vtt-mcp`, a stdio MCP server. The
command an agent host launches is:

```sh
pnpm --silent --dir <absolute repo path> mcp
```

With Claude Code:

```sh
claude mcp add vtt -- pnpm --silent --dir <repo> mcp
```

Any other host that takes a JSON server entry:

```json
{"command": "pnpm", "args": ["--silent", "--dir", "<repo>", "mcp"]}
```

`<repo>` is the absolute path of this checkout. No token is needed: while a
table is being served, `vtt-mcp` finds it through the discovery file the
server writes (`$XDG_CONFIG_HOME/vtt/session.json`, by default
`~/.config/vtt/session.json`).
If no table is being served yet, it waits for one. At startup the agent
receives a short orientation: the docs it can read, the first queries to
make, the GM binder's templates and the rule for stale writes.

## Keys and gestures

Press `?` in the app (or the toolbar's "?" button) for the same list. No key
fires while you are typing in a text field.

| Key | Does |
|---|---|
| `V` | Select tool |
| `T` | Token tool |
| `C` | Card tool |
| `N` | Note tool |
| `R` | Rectangle zone tool |
| `O` | Circle zone tool |
| `P` | Polygon zone tool |
| `I` | Image tool |
| `D` | Ink tool |
| `W` | Text tool |
| `L` | Layout tool |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+S` | Save |
| `+` | Zoom in |
| `=` | Zoom in (the + key without Shift) |
| `-` | Zoom out |
| `?` | Show or hide this help |

Undo reverses your own latest change, including a button you pressed while
viewing as a character; it never reverses the agent's work.

| Gesture | Does |
|---|---|
| Space-drag or middle-drag | pan |
| Wheel or two-finger scroll | pan (over a list that scrolls: scroll it) |
| Ctrl/Cmd+wheel or pinch | zoom about the pointer |
| Click | select |
| Alt+click | cycle through the objects under the pointer |
| Drag one template | drop a copy |
| Alt held at drag start | move the template instead of copying it |
| Alt held at drop onto an object | put the dragged objects inside it |
| Snap on (toolbar, the default) | a moved or dropped object lands on a half unit; the grid shows |
| Drop on a card's editor field | set that cell to the dropped object |
| Drop on a list | insert there |
| Drop a template on a binder | give that binder a template |
| Double-click | run the object's default action, else edit in place |
| Click an editor field | edit it |
| Chevron on a list entry | expand or collapse it (a template entry makes a working copy) |
| Gear | edit a template |
| Drag a cell row from the inspector onto an object (layout mode) | show the cell on the face |
| Delete | remove the selection |
| Move selection to board… | move objects between boards |

## Docs

- [docs/DESIGN.md](docs/DESIGN.md): the model, the UI, agents, scope, and
  the decision log.
- [docs/FORMULAS.md](docs/FORMULAS.md): the formula and action language.
- [docs/PROTOCOL.md](docs/PROTOCOL.md): the wire protocol, the server flags
  and the MCP server.
- [docs/FIXTURES.md](docs/FIXTURES.md): the machine-readable acceptance
  fixtures.
- [docs/FIRST-SESSION.md](docs/FIRST-SESSION.md): the first-session
  playtest guide.

## Workflow

Scripts in [scripts/](scripts/) encode the loop in [CLAUDE.md](CLAUDE.md). They are plain bash
and need `git`, `bd`, `pnpm`, `codex`, and `jq` on `PATH`; each exits non-zero with a message if a tool
it uses is missing.

- `scripts/worktree.sh <bead-id> <slug>` creates branch `<bead-id>/<slug>` from `main` in
  `../vtt-worktrees/<bead-id>` (next to the main checkout), runs `pnpm install --frozen-lockfile`
  there, and checks that `bd show <bead-id>` works from inside the new worktree.
- `scripts/review-bead.sh <bead-id> [base]` runs from inside a bead's worktree. It sends Codex
  (`codex exec`, read-only sandbox) the bead text, review rules (findings are advisory and tagged
  IN-SCOPE or OUT-OF-SCOPE; every Done-when condition gets a verdict), and `git diff <base>...HEAD`
  without `pnpm-lock.yaml`. `base` defaults to `main`.
- `scripts/review-plan.sh <epic-id>` sends Codex the epic and every child bead and asks for
  missing dependencies, overlapping scope, oversized beads, gaps against the named doc sections,
  and bad decisions, each with bead id, severity (blocker / should-fix / nit), problem, and
  proposed change, plus an overall verdict.

Both review scripts print the review to stdout and save it to `.reviews/<id>-<timestamp>.md` in
the current worktree (gitignored). Codex progress goes to stderr. A review takes a few minutes.
