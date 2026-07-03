# Changelog

## Unreleased

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
