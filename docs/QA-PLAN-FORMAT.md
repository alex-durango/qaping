# QA-PLAN.md — the format

`QA-PLAN.md` lives at the GAME repo's root. The agent authors and maintains it;
the developer owns it and approves every commit. Agents parse it by reading —
keep it exactly this shape, nothing fancier.

## Plan frontmatter

YAML at the very top of the file:

```yaml
---
game: Solar Drift
game_slug: solar-drift                          # the issue board's id — minted ONCE, never renamed
build_command: ./scripts/package.sh --release   # the ONE command that produces a shippable build
platforms: [windows]                            # windows | macos | ios | web
input: XInput gamepad                           # optional; default keyboard+mouse
---
```

`game_slug` is minted once from the game name — lowercase, every run of
non-alphanumerics collapsed to a single `-`, no leading or trailing `-`, ≤64
characters — and is then permanent, exactly like a check id: it names the
game's issue board, and renaming it orphans every issue filed under the old
one. Every playtest round is filed with it as `game`.

`build_command` is recorded once at setup so every future run can build without
asking. `platforms: [web]` means a browser-playable game — its "build" is a
static directory, not a zip. `input` declares the hardware the
first-15-minutes check (and any check that needs it) is played on — rounds
must ask playtesters to confirm what they actually used.

## Checks

One `##` section per check; the heading is the check's short name. The section
opens with a fenced yaml block, then the steps as prose:

```yaml
id: save-loads            # stable slug — never reused, never renamed
rung: human               # human | code
state: unverified         # unverified | passed | ambiguous | failing
origin: authored          # "authored", or the round id that minted/last changed it
last_verified: 2026-08-25 # date or build tag of the last passing verification
setup: "?save=campaign-mid"  # optional: the link/flag that forces this check's precondition
```

- **Steps are prose for a person**: numbered, imperative, written so a
  playtester who has never seen the game can follow them. At filing time each
  check becomes ONE id-tagged step with typed verdict options, so end the
  steps in an observation ask ("describe what you saw"), never a
  confirmation ("confirm it appears").
- **`state` is the check's verdict history**: `unverified` (never verified on
  the current behavior), `passed` (last verified answer was Pass),
  `ambiguous` (a fail that could be dirty state or tester noise — refiles
  alone as a targeted round), `failing` (a fail backed by hard evidence or a
  targeted round). Blocked/VOID outcomes change nothing here.
- **`setup` names the test affordance** that forces the check's precondition —
  a URL param (`?fresh=1`, `?state=<checkpoint>`), a flag, a bundled-fixture
  load control. At filing time the hook rides the ROUND's `url` — the review
  interface loads it itself; testers cannot open links or type URLs — and
  the filed step states only the player-visible expectation, never the
  mechanism. A check
  whose precondition can be neither forced nor verified is testimony-only —
  say so in its prose.
- **Fixtures are provisioned by the dev's repo**: a previous-version save
  ships inside the build (or seeds via URL param on web) and is named in the
  check's steps — an anonymous playtester in a fresh browser cannot possess
  it.
- **Order the file critical-path first**: boots to menu, previous-version save
  loads, first 15 minutes on the declared input hardware, core loop, settings
  persist — then game-specific checks.
- A `rung: code` check keeps its prose (it documents intent) and adds one
  `test:` line naming the repo test that now asserts it, e.g.
  `` test: `tests/save_compat.test.ts` ``. Mechanically-assertable checks
  enter at `rung: code` on day one — human rounds are for judgment.

## Example section

````markdown
## A previous-version save loads

```yaml
id: save-loads
rung: human
state: unverified
origin: authored
last_verified: never
setup: "?save=campaign-mid"
```

1. The game opens already loaded into the save "campaign-mid.sav" (made on
   the previous release; the round's link forces it — no action needed).
2. Play for one minute in the desert outpost.
3. Describe what you saw: where you resumed, what the inventory held, and
   anything missing, corrupted, or visually wrong.
````

## Bugs live on the issue board; checks live here

A check is what the game must ALWAYS do — it belongs in this file, forever. A
bug is what the game does wrong right now — it belongs on the game's issue
board (`qaping issues <game_slug>`, moved by the agent through the
`qaping_issues` tool), where it is numbered, carried across rounds, and
retired when it is gone. Do not write bugs into `QA-PLAN.md`: a check written
to describe one bug ("the shop does not close when you press B twice") ages
into a puzzle the moment the bug is fixed.

The board is what makes a fix provable. The agent may CLAIM a fix (with the
exact build URL the next round will play); only a playtester answering
"Gone" on a round filed after that claim — against that same build — turns the
issue *verified*, and a "Still here" on a claimed fix regresses it. A blocker
or a major needs TWO playtesters to say "Gone" before it turns green; a minor
or cosmetic needs one.

Because every round is filed with `game`, the board's live issues ride it as
the playtester's checklist — no step budget spent, no bug forgotten between
patches. The checklist is sized to the session (8 issues on a 5-minute round,
18 on a 30-minute one, 20 at the ceiling) and it rotates, so a minor filed
weeks ago comes back round instead of starving behind the blockers. Each
issue gets one of four answers: **Still here**, **Gone**, **Couldn't test**
(reached it, still could not tell) or **Didn't reach** (never got to that part
of the game).

A check and the bug that came from it stay linked through the issue's
`check_id`: the same id this file gives the check. Each issue also carries an
optional `area` — one or two words a player recognises, like "camp screen" —
which is how the checklist groups itself into a route through the game.

## The round ledger — qa-rounds.jsonl

Beside the plan, at the game repo root, sits `qa-rounds.jsonl`: one JSON line
appended per round, committed alongside the plan updates —

```json
{"round_id": "…", "report_url": "…", "build": "<sha or hosted url>",
 "evidence_grade": "…", "checks": [{"id": "…", "outcome": "…"}],
 "issues": {"game": "solar-drift", "verified": [3], "regressed": [5],
  "new": [7], "unreached": [9], "still_open": [2]},
 "verdict": "…", "credits": 20, "follow_ups": ["…"]}
```

Outcomes are `Pass | Fail | Blocked | NOT-ASKED` — a VOID (precondition
unverified/disproven) is recorded as `Blocked` with a "VOID: …" note in the
report, never its own enum value. `report_url` is the round's service report
page (what the results tool returns), never a PR or issue link. There is no
evidence-link field, deliberately: signed recording URLs expire in days.
The ledger is the machine truth of what was asked and answered, per check,
per round; the plan's `last_verified` and `state` are derived from it and
stay the dev-readable contract. `issues` is what this round did to the issue
board, by number (omitted when the round carried no `game`); `unreached` is
the issues whose only answer was "Didn't reach" — carried, shown, and never
got to. `follow_ups` is NON-BUG follow-ups only — a check to add, a build
affordance to write, a question to settle; bugs go on the board, where they
are numbered and re-checked. Open `follow_ups` are what the next filing must
carry forward.

## Rounds still open — qa-open-rounds.json

A playtest may run for many hours, so a round the agent cannot sit through is
PARKED: filed with an explicit long deadline, then recorded in
`qa-open-rounds.json` (same directory) so a LATER session collects it —

```json
{"rounds": [{"ping_id": "<uuid>", "filed_at": "<ISO>", "platform": "windows",
  "build": "<the hosted or store URL>", "est_minutes": 10,
  "deadline_seconds": 86400, "game": "solar-drift",
  "checks": ["<check ids>"], "note": "<the patch this round covers>"}]}
```

`qaping rounds` lists it with each round's live status, `qaping rounds add`
(with `--game` for the board this round carries) records one,
`qaping rounds rm` drops it once collected. This file is the
opposite of the ledger and never merges with it: mutable OPEN state, one entry
per round still owed, emptied as rounds land. It is not history — gitignore it.

The server keeps every successfully filed round independently of this file.
Use `qaping rounds --all` (or `--remote`) to find them from any directory, or
`qaping rounds --all --game solar-drift --json` for one game's rounds. A page
includes each round's `ping_id`, current status, game, build URL, platform,
filing time, deadline, session counts and report URL. It includes completed
and expired rounds too. The default page size is 50 (`--limit 1-100`);
pass the returned `next_cursor` as `--cursor` for older rounds.

On resume, compare server IDs with both local files before filing anything
new. A round already in `qa-rounds.jsonl` has been collected. Restore only
missing work belonging to this repo, preserve local notes/checks, and recover
check IDs from the actual results rather than guessing. Omit `--game` when
recovering older rounds filed without a slug. Listing is read-only: it never
rewrites either file or renews a lease, and a failed fetch is an error, not an
empty account. The endpoint is `GET /api/rounds?game=<slug>&limit=50&cursor=…`,
authenticated with the same account token the CLI already uses.

## Maintenance rules

- Every run updates the run checks' `state` and `last_verified` from typed
  outcomes (Pass stamps both; Blocked/VOID/NOT-ASKED touch neither);
  findings-driven edits record the round id as `origin`.
- New checks start `rung: human` (unless mechanically assertable — then
  `rung: code` with a repo test written at entry), `state: unverified`,
  `origin: authored`.
- Promotion (human → code) and any deletion/demotion happen only with the
  developer's explicit agreement.
- **QA memory**: the plan accretes from conversation, not just QA runs — when
  the developer mentions something that should always be tested, a fragile
  area, or a lesson learned, the agent offers to record it as a check (or a
  note on an existing check) right then.
