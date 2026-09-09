# Install on Windows

Set up Qaping in PowerShell, connect it to your coding agent, and check that
you are ready to start QA. You need an internet connection and **Claude Code,
Cursor, or Codex** installed on your PC.

These steps use native Windows. If you run your agent inside WSL, follow
[the WSL instructions](#using-wsl) below instead.

## 1. Install Node.js

Qaping runs on Node.js, even if your game is built with Unreal, Unity, or
Godot. You do not need to turn your game into a JavaScript project.

1. Open the [Node.js download page](https://nodejs.org/en/download).
2. Choose **Node 24 LTS**, **Windows**, and **Windows Installer (.msi)**.
   Use **x64** for an Intel or AMD PC, or **ARM64** for a Windows ARM PC.
3. Run the installer, keeping the npm and Add to PATH options enabled.
4. Close and reopen your terminal. If you use a terminal inside your editor,
   restart the editor too so it picks up the new PATH.

If you already manage Node versions, select Node 24 through your existing
version manager. An existing Node 22 installation at **22.13.0 or later**
also works with Qaping.

Open the Start menu, search for **PowerShell**, and open it under the Windows
account you use for your coding agent. A PowerShell prompt starts with
`PS`, such as `PS C:\Users\Alex>`.

Run each line separately:

```powershell
node --version
npm.cmd --version
npx.cmd --version
```

All three should print a version number. The `.cmd` suffix selects npm's
Windows command launcher; this guide uses it for npm, npx, and Qaping so
PowerShell does not select a `.ps1` launcher blocked by its script policy.

## 2. Connect your coding agent

Install and open your coding agent at least once before running setup.
For Claude Code, install the CLI using its
[Windows setup instructions](https://code.claude.com/docs/en/setup#set-up-on-windows)
and check that `claude --version` works in this PowerShell window.

Run **one** command for the agent you use:

| Your coding agent | PowerShell command |
|---|---|
| Claude Code | `npx.cmd @qaping/cli@latest setup claude-code` |
| Cursor | `npx.cmd @qaping/cli@latest setup cursor` |
| Codex | `npx.cmd @qaping/cli@latest setup codex` |

Or let setup detect your installed agents:

```powershell
npx.cmd @qaping/cli@latest setup
```

If npm asks to install `@qaping/cli`, type `y` and press Enter. Setup installs
the `qaping` command, registers the Qaping MCP server, and installs the Qaping
skill for your agent. You can run setup from any folder; it configures your
Windows account. Run it again with another agent name to connect that agent too.

## 3. Sign in and check the connection

When setup opens your browser, sign in or create your account and approve
the connection. Keep PowerShell open until setup finishes. If no browser
opens, copy the approval link printed in the terminal into your browser and
enter the one-time code if asked. An existing valid login is reused.

After setup finishes, check:

```powershell
qaping.cmd version
qaping.cmd whoami
```

The first command prints your installed Qaping version. The second shows
the account you are signed in as. These checks do not file a playtest or
spend credits.

Restart your coding agent and start a new session. Check that its MCP tools
include the **qaping** server and these four tools:

- `qaping_playtest`
- `qaping_results`
- `qaping_wait`
- `qaping_issues`

The CLI login check and the agent's tool list check different parts of setup;
check both before starting a round.

## 4. Set up QA for your game

Open your game repo in your coding agent and ask:

```text
Set up QA for my game. Use qaping.
```

Your agent writes `QA-PLAN.md` with your game's build command and checks.
After your next change, ask:

```text
Run QA on this patch. Use qaping.
```

There are **no free playtests**. [Subscribe or buy credits](https://qaping.dev/#pricing)
before filing a round; your agent states the estimated cost first.

When typing CLI commands from the other guides in PowerShell, use
`qaping.cmd` in place of `qaping`. Quote file paths that contain spaces:

```powershell
qaping.cmd publish-build "C:\Games\My Game\Builds\game.zip" --platform windows
```

That command uploads an already packaged Windows game ZIP. Your agent can
handle building and publishing for you as part of the QA loop. See the
[CLI reference](COMMANDS.md) for the other commands.

## Using WSL

Run setup in the environment where your agent reads its configuration.
For an agent running natively on Windows, use PowerShell as above. For an
agent CLI running inside a WSL Linux distribution, install Node.js and the
agent inside that distribution, then run Qaping setup there too.

In your WSL terminal, first check the Node installation:

```sh
node --version
node -p "process.platform"
```

The platform should be `linux`. If it prints `win32`, your shell is finding
Windows Node; select a Linux Node installation before continuing.

Then run, choosing your agent as in the table above:

```sh
npx @qaping/cli@latest setup claude-code
qaping version
qaping whoami
```

Use `npx` and `qaping` without `.cmd` inside WSL. Windows and WSL have
separate home directories, agent settings, and Qaping logins. Setup in
PowerShell does not configure an agent running inside WSL, or vice versa.

## Troubleshooting

### Node, npm, or npx is not recognized

Finish installing Node.js, then close and reopen PowerShell and your editor.
Check which executables Windows can find:

```powershell
where.exe node
where.exe npm.cmd
where.exe npx.cmd
```

If they are missing, repair your Node installation with npm and Add to PATH
enabled. If you use a version manager, activate a supported Node version in
this terminal. An `EBADENGINE` warning or an unsupported Node message also
means you should check `node --version` and switch to Node 24 LTS.

### PowerShell says running scripts is disabled

If the error names `npx.ps1`, `npm.ps1`, or `qaping.ps1`, use the `.cmd`
commands in this guide. For example:

```powershell
npx.cmd @qaping/cli@latest setup cursor
```

You do not need to change PowerShell's execution policy for these commands.
PowerShell supports choosing an executable by its
[file extension](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_command_precedence#resolve-items-with-the-same-names).

### Setup ran, but qaping.cmd is not recognized

Reopen PowerShell first. If setup reported that the global install failed,
install the command explicitly:

```powershell
npm.cmd install --global @qaping/cli@latest
qaping.cmd version
```

If installation succeeds but the command is still missing, find npm's
global command directory:

```powershell
npm.cmd prefix --global
```

On Windows, npm places global command launchers directly in that directory
([npm folder documentation](https://docs.npmjs.com/cli/v11/configuring-npm/folders/)).
Search Start for **Edit environment variables for your account**, edit
**Path** under your user variables, and add the printed directory as a new
entry. Keep the existing entries, then restart PowerShell and your agent.

You can also run a command through npx while fixing PATH:

```powershell
npx.cmd @qaping/cli@latest whoami
```

### The agent cannot find Qaping's tools

Run setup again with the explicit agent name, then restart that agent and
start a new session. Use the same Windows account as the agent. If you use
WSL, check that setup ran in the same environment as the agent.

For a `claude mcp add` failure, confirm that `claude --version` works in the
same terminal. Use Claude Code's native Windows CLI installation linked
above, then retry `npx.cmd @qaping/cli@latest setup claude-code`.

If `qaping.cmd whoami` says you are not signed in, run setup again and
complete the browser approval. If the one-time code expires, rerun setup
to get a new code.

## Update Qaping

Update the installed command, then rerun setup to refresh your agent's skill
and connection. Replace `cursor` with your agent name:

```powershell
npm.cmd install --global @qaping/cli@latest
qaping.cmd setup cursor
qaping.cmd version
```

Restart the agent after updating. If you still need help,
[report an issue](https://github.com/alex-durango/qaping/issues) with your
Node version, Qaping version, agent, and error message. Leave tokens and
one-time sign-in codes out of the report.
