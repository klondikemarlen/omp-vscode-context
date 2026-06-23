# Oh My Pi Context Bridge

VS Code extension plus Oh My Pi extension for sending the active editor location to OMP with `Ctrl+Alt+K`.

## What it does

Press `Ctrl+Alt+K` on Linux/Windows or `Cmd+Alt+K` on macOS while a VS Code editor is focused.

With a selection, OMP receives a file reference by default:

```text
In @src/example.ts#L7C17-L9C20 
```

Without a selection, OMP receives the current file and cursor position:

```text
In @src/example.ts#L7C17 
```

The inserted prompt ends with a trailing space so you can keep typing immediately after the reference.

The default is reference-only because OMP can read saved workspace files directly. This avoids pasting large selections into the prompt and avoids OMP's large-paste attachment chooser. Set `ompContext.contentMode` to `inline` if you need the selected text copied into the prompt as a fenced code block.

If the OMP bridge is not reachable, the VS Code extension copies the same context block to the clipboard.

## Install

You need both pieces:

1. The VS Code extension captures editor state.
2. The OMP extension receives the context and inserts it into the OMP prompt.

### VS Code Marketplace

Install or update from Marketplace:

```bash
code --install-extension klondikemarlen.omp-vscode-context --force
```

Or use VS Code's Extensions view and search for **Oh My Pi Context Bridge**. Marketplace installs normally auto-update with VS Code unless extension auto-update is disabled.

Links:

- Marketplace: https://marketplace.visualstudio.com/items?itemName=klondikemarlen.omp-vscode-context
- Marketplace publisher hub: https://marketplace.visualstudio.com/manage/publishers/klondikemarlen/extensions/omp-vscode-context/hub?_a=acqu
- GitHub: https://github.com/klondikemarlen/omp-vscode-context

### OMP plugin

Install the companion OMP extension from GitHub:

```bash
omp plugin install github:klondikemarlen/omp-vscode-context
```

`omp install github:klondikemarlen/omp-vscode-context` also works; `omp plugin install` is clearer because this is an OMP plugin, not the VS Code extension.

Update an already-installed GitHub plugin with the same command:

```bash
omp plugin install github:klondikemarlen/omp-vscode-context
```

Then restart OMP or run `/reload-plugins`.

OMP now refreshes GitHub plugin lockfile pins when you re-run `omp plugin install`; the old manual `cd ~/.omp/plugins && bun update omp-vscode-context` workaround is no longer needed.

This plugin is installed from the GitHub repo because it ships an OMP runtime extension, while the VS Code half is installed from Marketplace.

### Local development install

For normal use, install from GitHub as shown above. For development on a local checkout, link the local package so OMP loads your working tree instead of a pinned GitHub commit:

```bash
git clone https://github.com/klondikemarlen/omp-vscode-context.git
cd omp-vscode-context
npm install
npm run package:vsix
omp plugin link "$PWD"
```

Then restart OMP or run `/reload-plugins`, and install the generated `.vsix` in VS Code. Local edits to `omp/index.js` take effect after `/reload-plugins`; VS Code extension edits still require rebuilding/reinstalling the `.vsix`.

## Multiple OMP terminals

Each OMP terminal runs its own local bridge. The VS Code extension reads `~/.omp/agent/editor-context-bridge.json` and sends `Ctrl+Alt+K` context to the bridge recorded there.

The active target is updated when an OMP session starts or switches. To explicitly route VS Code context to the terminal you are looking at, run:

```text
/vscode-context-here
```

To see the active endpoint and plugin version in a terminal, run:

```text
/vscode-context-status
```

## Settings

- `ompContext.endpoint`: optional endpoint override. Empty means read `~/.omp/agent/editor-context-bridge.json`, then fall back to `http://127.0.0.1:47687`.
- `ompContext.contentMode`: `reference` (default) sends only `@file#LxCy-LxCy`; `inline` includes selected text too.
- `ompContext.delivery`: `paste` (default), `send`, or `nextTurn`.

## Publish

Marketplace publishing uses `@vscode/vsce`.

Before publishing:

```bash
npm test
npm run package:vsix
```

Publish a new version:

```bash
npm version patch --no-git-tag-version
npm run publish:marketplace
```

`npm run publish:marketplace` runs `vsce publish`, which runs `npm run vscode:prepublish` first. The prepublish step type-checks and bundles `dist/extension.cjs`.

Authentication:

```bash
npx vsce login klondikemarlen
```

Use a Visual Studio Marketplace/Azure DevOps PAT with **Marketplace → Manage** scope. The publisher id is `klondikemarlen`; do not use an email address.

After publishing, verify both directions:

- GitHub README links to the Marketplace listing and publisher hub.
- Marketplace listing links back to this GitHub repository through `repository` and `homepage` metadata.

## Concepts

See [CONCEPTS.md](./CONCEPTS.md) for the architecture, data contract, bridge security model, delivery modes, and known limits.

## Security model

- The OMP bridge binds only to `127.0.0.1`.
- OMP writes a random bearer token to `~/.omp/agent/editor-context-bridge.json` with `0600` permissions.
- The VS Code extension reads that file and sends the token on each request.

## Research notes

- OpenCode's VS Code extension binds `Ctrl+Alt+K` on Linux/Windows and `Cmd+Alt+K` on macOS to insert an `@file#Lx-Ly` reference. Its TUI exposes `POST /tui/append-prompt` for prompt insertion.
- Claude Code's current documented shortcut is `Alt+K` on Linux/Windows and `Option+K` on macOS for **Insert @-Mention Reference**. Its extension also sees selected text automatically.
- OMP has extension UI methods including `pasteToEditor` and `sendUserMessage`, but no built-in VS Code selection bridge. This repo supplies that missing bridge.
