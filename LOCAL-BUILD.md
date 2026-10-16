# Local patched build

The `wes-main` branch carries Roughdraft patches that are not meant for upstream. Build from it, start new fixes on short topic branches, merge them into `wes-main`, and rebase `wes-main` onto upstream `main` when updating. It is backed up to the fork `wessport/roughdraft` (remote `fork`). Never push it to `Lex-Inc/roughdraft`; see `AGENTS.md`.

The active CLI is `~/.local/bin/roughdraft`, a symlink to
`~/.local/share/roughdraft-save-order-patched/node_modules/.bin/roughdraft`. That install is
produced from this checkout. Its `package.json` depends on
`file:../../../repos/github/roughdraft/.context/autosave-handoff-package/roughdraft-0.1.10.tgz`
plus `yaml@^2.9.0`. The `yaml` dependency works around the published 0.1.10 package omitting it.

## Rebuild and reinstall

```bash
cd ~/repos/github/roughdraft
pnpm install
pnpm check            # lint, selectors, unit tests, build
npm pack --pack-destination .context/autosave-handoff-package
npm install --prefix ~/.local/share/roughdraft-save-order-patched \
  ./.context/autosave-handoff-package/roughdraft-0.1.10.tgz yaml@^2.9.0
```

To check that an install matches this checkout, compare it with a fresh build:

```bash
I=~/.local/share/roughdraft-save-order-patched/node_modules/roughdraft
for d in app/dist rfm/dist server/dist server/bin; do diff -rq "packages/$d" "$I/packages/$d"; done
```

## Activation

- CLI-only changes, such as `roughdraft watch`, apply to the next command.
- Server or app changes need the shared server on port 7373 restarted. Ask the user first, because a restart interrupts open reviews. Then `roughdraft stop` and `roughdraft start`, and check that `/api/status` reports the expected `serverRoot`.
- Open review tabs must be refreshed after their drafts are saved.
