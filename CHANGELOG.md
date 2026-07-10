# Changelog

## 1.6.6

- Add an OMP-side cosmetic paste separator so typing after a context paste does not run into the paste badge.

## 1.6.5

- End handoff packets with an edit-friendly blank line and move the endpoint override into advanced settings.

## 1.6.4

- Make the bounded agent handoff packet the default `Ctrl+Alt+K` mode, with minimal token fallbacks still available through settings.

## 1.6.3

- Remove low-value handoff packet settings and omit visible editor references from handoff output.

## 1.6.2

- Prioritize `ompContext.insertMode` in VS Code settings and mark handoff-only tuning settings as advanced.

## 1.6.1

- Add `ompContext.insertMode` so `Ctrl+Alt+K` can opt into handoff packets, and quiet handoff output by omitting empty sections and duplicate active-editor references.

## 1.6.0

- Add the `OMP Context: Insert Agent Handoff Packet` command for bounded Markdown handoffs with active editor context, workspace root, visible editor references, capped diagnostics, byte caps, and clipboard fallback.

## 1.5.1

- Document the Devin Desktop CLI as a Marketplace install fallback when `code` is unavailable.

## 1.5.0

- Clarify that inline mode is stale-safe because it sends both the file reference and exact selected text.

## 1.4.0

- Document OMP 16.3.7+ as the supported runtime floor and remove the older prompt repaint workaround from the bridge.

## 1.3.3

- Make inline context the default so selected text is pasted with the file reference; keep reference mode as the compact optimization.

## 1.3.2

- Remove the redundant `ompContext.delivery` setting and hidden non-paste bridge delivery paths.

## 1.3.1

- Remove the `selection` content mode to keep context formatting settings focused on reference and inline modes.
- Document the post-publish Marketplace polling and reinstall verification step.

## 1.3.0

- Add `selection` content mode for sending only selected text as a fenced code block.
- Document the issue-to-merge feature workflow.

## 1.2.2

- Improve the prompt repaint workaround for older OMP builds.

## 1.2.1

- Wait for delayed OMP prompt paste state before forcing repaint.

## 1.2.0

- Rename OMP routing commands to `/ide` and `/ide-status`.
- Preserve the active live bridge when multiple OMP terminals are open.
- Force prompt repaint after VS Code context paste so inserted text is visible immediately.

## 1.0.1

- Refresh OMP prompt rendering after VS Code context paste.
- Send only the delivery mode and prompt text over the bridge.

## 1.0.0

- Remove the leading `In` from inserted context references.
- Reduce routine success notifications from VS Code and the OMP bridge.

## 0.1.6

- Update VS Code and OMP install instructions; re-running `omp plugin install` now refreshes existing GitHub plugins.

## 0.1.5

- Clarify normal OMP plugin install and update commands.
- Document local development linking with `omp plugin link`.

## 0.1.4

- Include character positions in file references.
- Add a trailing space after inserted references for continued typing.

## 0.1.3

- Add OMP commands for routing VS Code context to a chosen terminal.
- Document GitHub plugin updates through Bun's plugin lockfile.
- Include the plugin version in the OMP bridge state and status command.

## 0.1.2

- Improve Marketplace metadata and README install instructions.
- Document Marketplace, publisher hub, and GitHub links.

## 0.1.1

- Default selected code to file references instead of inline code blocks.
- Add `ompContext.contentMode` for opting back into inline selected text.

## 0.1.0

- Publish the initial VS Code command for sending active editor context to OMP.
- Include the companion OMP loopback bridge extension for prompt insertion.
- Document the bridge concepts, data contract, security model, and delivery modes.
