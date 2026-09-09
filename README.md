<div align="center">
<a href="https://qaping.dev">
  <img alt="Qaping logo" src="./docs/icon.svg?v=2" width="120">
</a>

<h1 align="center">Qaping</h1>
<p align="center"><strong>Automatic QA for your game.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@qaping/cli"><img alt="npm version" src="https://img.shields.io/npm/v/%40qaping%2Fcli.svg"></a>
  <a href="https://www.npmjs.com/package/@qaping/cli"><img alt="npm downloads" src="https://img.shields.io/npm/dw/%40qaping%2Fcli.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://discord.gg/pUKzftBUTY"><img alt="Join Discord" src="https://img.shields.io/badge/discord-join-5865F2.svg?logo=discord&amp;logoColor=white"></a>
</p>

[Website](https://qaping.dev) · [Documentation](https://alex-durango-qaping.docs7.io) · [Report an issue](https://github.com/alex-durango/qaping/issues)

</div>

## About

Qaping connects your coding agent to real human playtesters. Your agent writes
the QA plan, publishes each patch's build, and reports what players found.

- **Check what changed.** The agent reads the diff and picks the parts of your
  game that need another pass.
- **Get real playtesting.** People play your build on their own hardware and
  report what works, what breaks, and what they could not test.
- **Verify the fix.** Bugs stay on your game's issue board across patches.
  A fix is verified only after playtesters check it in a later build.

Works with **Claude Code, Cursor, and Codex**, for games on **Windows, macOS,
iOS, and the web**.

Every playtest includes the standard 11-question player-experience questionnaire.
Your agent can add up to eight custom questions after it; it cannot disable the
standard questionnaire.

## Quickstart

Install [Node.js](https://nodejs.org/en/download) first (Node 24 LTS recommended),
then set up Qaping for your coding agent.

**Windows — PowerShell:**

```powershell
npx.cmd @qaping/cli@latest setup
```

See [Install on Windows](docs/WINDOWS.md) for a walkthrough from a fresh PC,
agent-specific commands, and troubleshooting.

**macOS, Linux, or WSL:**

```sh
npx @qaping/cli setup
```

Setup connects the MCP server, installs the Qaping skill, and signs you in.
To choose an agent, append `claude-code`, `cursor`, or `codex` to the command.

Open your game repo in that agent and ask:

```text
Set up QA for my game.
```

After your next change:

```text
Run QA on this patch.
```

Your agent keeps the plan in `QA-PLAN.md`, so checks and past results stay with
your game. QA runs from your coding agent when you ask it to run a patch.

## Example prompts

| When | Ask your agent | What you get |
|---|---|---|
| Starting a game | `Set up QA for my game.` | A QA plan based on your game and build process. |
| Shipping a patch | `Run QA on this patch.` | Targeted playtests and a report on the pull request. |
| Checking a regression | `Did this patch break anything? Use qaping.` | Checks selected from the diff, with a result for each one. |
| Testing a build | `Playtest this build: <build URL>. Use qaping.` | Feedback from real players on the build you share. |
| Rechecking a fix | `I fixed the save bug. Run QA and have players recheck it.` | Player confirmations attached to the bug on your issue board. |

## How it works

1. **Plan the checks.** The agent reads your diff and `QA-PLAN.md`, then selects
   the behavior the patch could have changed.
2. **Publish the build.** It uses your recorded build command and hosts the
   playable output, or uses your existing Steam, TestFlight, or build link.
3. **Players test it.** Real playtesters claim the round, follow the checks,
   and report a result for each one.
4. **Read the report.** Your agent summarizes the results on the pull request,
   links available evidence, and tracks bugs on the game's issue board.
5. **Carry it forward.** Later rounds recheck claimed fixes. Checks that can be
   reliably automated can become code tests with your agreement.

Serious fixes require confirmation from **two playtesters**; minor and cosmetic
fixes require one. An agent marking a bug fixed does not mark it verified.

## Supported platforms

| Platform | How players open the game | What comes back |
|---|---|---|
| Windows | Steam or your hosted ZIP | Answers and a screen recording; transcript when the Qaping recorder was used. |
| macOS | Steam, a notarized download, or your hosted ZIP | Answers, screen and voice recording, and a transcript. |
| iOS | A public TestFlight link or App Store page | Answers, screen and voice recording, and a transcript. |
| Web | Your published game's URL | Answers to your checks; no recording or transcript. |

## CLI commands

Your agent handles the QA loop. These commands let you inspect its work:

```sh
qaping builds                 # List your hosted native builds
qaping rounds                 # Unprocessed rounds on your account
qaping rounds --all           # Include processed history
qaping rounds --game <slug>    # Resume one game's QA work
qaping rounds import          # One-time migration of older local round files
qaping rounds                 # Check this repo's locally recorded rounds
qaping results <round_id>     # Read a round's results
qaping issues <game>          # See bugs and verification status
```

See the [complete CLI reference](docs/COMMANDS.md) for build publishing,
round management, and JSON output.

## Pricing

Rounds cost **2 credits per minute of play, per playtester**. For example,
two players testing for 10 minutes use 40 credits. Your agent states the
estimate before filing a round.

There are currently **no free playtests**. [Subscribe or buy credits](https://qaping.dev/#pricing)
before starting a round.

## Documentation and support

- [Documentation](https://alex-durango-qaping.docs7.io) — setup, commands, and the QA loop.
- [Install on Windows](docs/WINDOWS.md) — Node.js, PowerShell, agent setup, and troubleshooting.
- [QA-PLAN.md format](docs/QA-PLAN-FORMAT.md) — the checks your agent maintains in your game repo.
- [The Qaping skill](https://alex-durango-qaping.docs7.io/skill) — the full workflow your agent follows.
- [Issues](https://github.com/alex-durango/qaping/issues) — bug reports and feature requests.
- [Discord](https://discord.gg/pUKzftBUTY) — questions and community support.

## License

[MIT](LICENSE)

Round context, processing state, reports and follow-ups live on the server.
`QA-PLAN.md` defines the checks in your repo; local round ledgers are no longer required.
