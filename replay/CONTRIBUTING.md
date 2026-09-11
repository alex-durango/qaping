# Contributing

Bug reports, documentation improvements, and pull requests are welcome.

Use Node.js 20 or later. From the `replay` folder, run `npm test` for the portable tests. Windows, an
Xbox-compatible controller, and the dependencies listed in the README are needed
to exercise recording and playback. Public CI tests portable behavior; it does
not certify gamepad drivers or performance on your machine.

For a bug report, include Replay version, Windows version, controller setup,
command, and the expected and actual behavior. Remove personal paths and account
information from any receipt or trace you attach. Do not upload game binaries,
crash dumps, credentials, or personal saves.

This repository is generated from the project's canonical development tree.
Maintainers incorporate accepted contributions there and regenerate the public
source. The npm package is `@qaping/rig`; source snapshots can be ahead of the published
version. See the README for the current release status.
Source-only files, such as these tests and guides, are not required by the npm
installation.
