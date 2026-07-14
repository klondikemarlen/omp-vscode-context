# Oh My Pi Context Bridge

VS Code extension plus Oh My Pi extension for sending the active editor location to OMP with `Ctrl+Alt+K`.

## What it does

Press `Ctrl+Alt+K` on Linux/Windows or `Cmd+Alt+K` on macOS while a VS Code editor is focused.

By default, OMP receives a bounded agent handoff packet with the active editor context, workspace root, and diagnostics when present:

````text
# OMP Agent Handoff

## Active editor

@src/example.ts#L7C17-L9C20 

```typescript
const value = 1
return value
```

## Workspace

- Root: `/path/to/workspace`
````

The default inline content mode is stale-safe for ordinary selections: it includes the reference plus selected text as a fenced code block, so OMP receives the exact bytes you selected unless the bounded handoff packet reaches `ompContext.handoffMaxBytes`. Set `ompContext.contentMode` to `reference` to send only `@file#LxCy-LxCy` when you prefer the smaller file-reference optimization.

If the OMP bridge is not reachable, the VS Code extension copies the same context block to the clipboard.

Set `ompContext.insertMode` to `editorContext` when you want `Ctrl+Alt+K` / `Cmd+Alt+K` to send only the active file reference and selected text.

## Install

You need both pieces:

1. The VS Code extension captures editor state.
2. The OMP extension receives the context and inserts it into the OMP prompt.

### VS Code Marketplace

Install or update from Marketplace:

```bash
code --install-extension klondikemarlen.omp-vscode-context --force
```

If the VS Code CLI is not installed but Devin Desktop is available:

```bash
devin-desktop --install-extension klondikemarlen.omp-vscode-context --force
```

Or use VS Code's Extensions view and search for **Oh My Pi Context Bridge**. Marketplace installs normally auto-update with VS Code unless extension auto-update is disabled.

Links:

- Marketplace: https://marketplace.visualstudio.com/items?itemName=klondikemarlen.omp-vscode-context
- Marketplace publisher hub: https://marketplace.visualstudio.com/manage/publishers/klondikemarlen
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

Supported OMP runtime: `16.3.7` or newer. That release includes upstream OMP [can1357/oh-my-pi#4342](https://github.com/can1357/oh-my-pi/pull/4342), which repaints the prompt after extension `pasteToEditor` / `setEditorText` mutations; older runtimes may still load the plugin but are outside this repo's support floor.

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

Session start keeps an existing live bridge; session switch claims the current terminal. To explicitly route VS Code context to the terminal you are looking at, run:

```text
/ide
```

To see the active endpoint and plugin version in a terminal, run:

```text
/ide-status
```

### Experimental Linux terminal focus routing

On Linux, enable **Claim IDE context on focus** in OMP **Settings → Plugins → omp-vscode-context**, or start OMP with `--claim-ide-context-on-focus`. Both are off by default; `/ide` remains the explicit override. This setting does nothing outside Linux.

The Linux-only feature uses xterm focus reporting, so it works with any Linux terminal or transport that forwards DECSET 1004 reports. Hover is not enough: the terminal must actually receive focus. Unsupported terminals preserve the normal manual route. This requires an OMP runtime that provides terminal-focus reporting.

When using a terminal multiplexer, configure it to forward xterm focus reports to OMP; otherwise automatic claiming stays inactive and `/ide` remains available.

## Settings

- `ompContext.insertMode`: primary shortcut mode. `agentHandoff` (default) sends the bounded handoff packet; `editorContext` keeps `Ctrl+Alt+K` / `Cmd+Alt+K` on the minimal file/selection prompt.
- `ompContext.contentMode`: selected-text format used by both modes. `inline` (default) includes the reference plus selected text as a fenced code block; `reference` sends only `@file#LxCy-LxCy`.
- Advanced settings:
  - `ompContext.endpoint`: optional endpoint override. Empty means read `~/.omp/agent/editor-context-bridge.json`, then fall back to `http://127.0.0.1:47687`.
  - `ompContext.handoffMaxBytes`: maximum bytes inserted by the handoff packet. Default: `20000`.
  - `ompContext.handoffMaxDiagnostics`: maximum VS Code diagnostics included in the handoff packet. Default: `20`.

Use the default `agentHandoff` + `inline` pair for hands-off agent work. Use `editorContext` for a lower-overhead packet shape, `reference` for lower selected-text token use, or both for the smallest file-reference-only fallback. The separate handoff command remains available as a one-off override.

Privacy boundary: the handoff packet is explicit and local, but it may include selected text, local paths, and diagnostics when those sections are non-empty. Obvious `token=`, `secret=`, `password=`, `apiKey=`, and `authorization=` diagnostic values are redacted; review the inserted prompt before submitting if the workspace contains sensitive data.

## Feature workflow

For user-facing feature work, a request to follow the feature release pattern means completing this whole sequence, not stopping at the pull request:

1. Create a GitHub issue with the user story and acceptance criteria.
2. Create a branch named for the issue.
3. Open a pull request linked to the issue.
4. Review the diff and run the smallest tests that cover the change.
5. Merge only after the PR is reviewed and checks pass.
6. For published changes, merge first, then bump the package version and changelog on `main`.
7. Publish, then poll the Marketplace (`npx vsce show klondikemarlen.omp-vscode-context --json`) until the new version appears.
8. Reinstall from the remote source and verify the installed version.

## Publish

Marketplace publishing uses `@vscode/vsce`.

Before publishing:

```bash
npm test
npm run package:vsix
```

Publish a new version:

```bash
npm version minor --no-git-tag-version
npm run publish:marketplace
```

`npm run publish:marketplace` runs `vsce publish`, which runs `npm run vscode:prepublish` first. The prepublish step type-checks and bundles `dist/extension.cjs`.

Authentication:

```bash
npx vsce login klondikemarlen
```

Use a Visual Studio Marketplace/Azure DevOps PAT with **Marketplace → Manage** scope. The publisher id is `klondikemarlen`; do not use an email address.

If this machine is already logged in with `vsce`, no `VSCE_PAT` environment variable is needed; `npm run publish:marketplace` uses the stored credentials. Set `VSCE_PAT` only for CI/non-interactive publishing or a machine without `vsce login` state.

After publishing, verify both directions:

- GitHub README links to the Marketplace listing and publisher hub.
- Marketplace listing links back to this GitHub repository through `repository` and `homepage` metadata.

## Concepts

See [CONCEPTS.md](./CONCEPTS.md) for the architecture, data contract, bridge security model, and known limits.

## Security model

- The OMP bridge binds only to `127.0.0.1`.
- OMP writes a random bearer token to `~/.omp/agent/editor-context-bridge.json` with `0600` permissions.
- The VS Code extension reads that file and sends the token on each request.

## Research notes

- OpenCode's VS Code extension binds `Ctrl+Alt+K` on Linux/Windows and `Cmd+Alt+K` on macOS to insert an `@file#Lx-Ly` reference. Its TUI exposes `POST /tui/append-prompt` for prompt insertion.
- Claude Code's current documented shortcut is `Alt+K` on Linux/Windows and `Option+K` on macOS for **Insert @-Mention Reference**. Its extension also sees selected text automatically.
- OMP has extension UI methods including `pasteToEditor` and `sendUserMessage`, but no built-in VS Code selection bridge. This repo supplies that missing bridge.
