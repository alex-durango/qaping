# qaping docs

The source of the qaping documentation site, generated from the `@qaping/cli`
package (version 0.2.0) at each release — nothing here is edited by hand,
and a pull request against this repository cannot land: fix the doc in the
package instead.

qaping is automatic QA for your game: your coding agent writes the QA plan,
ships each patch's build to real human playtesters, and reports what broke.

- Product: [qaping.dev](https://qaping.dev)
- Install: `npx @qaping/cli setup`
- Package: [@qaping/cli on npm](https://www.npmjs.com/package/@qaping/cli)

The site itself lives in [`docs7/`](docs7/) (a Mintlify-format `docs.json`
plus one MDX page per document).
