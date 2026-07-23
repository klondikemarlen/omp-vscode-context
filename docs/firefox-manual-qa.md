# Firefox Manual QA

Use this guide to verify the Firefox GitHub client and its automatic OMP delivery path. The test covers the user-visible flow that unit tests cannot prove.

## Prerequisites

- Node.js 20 or newer.
- Firefox 142 or newer. The extension declares this minimum for Firefox data-collection permissions.
- A GitHub account that can open the target pull request and its **Files changed** view.
- OMP with the repository plugin installed:

  ```bash
  omp plugin install github:klondikemarlen/omp-send-context
  omp plugin list
  ```

Confirm `omp-vscode-context@1.7.2` or newer is listed.

- A local checkout with dependencies installed:

  ```bash
  npm install
  npm test
  npx web-ext lint --source-dir firefox
  ```

- The native host installed as described in the [README](../README.md#firefox-native-host). Confirm that `~/.mozilla/native-messaging-hosts/omp_send_context.json` points to the executable checkout path and allowlists `omp-send-context@klondikemarlen.github.io`.

The `selenium-webdriver` development dependency is available for driver-based browser automation. Selenium Manager obtains a compatible geckodriver when the test environment permits it; these manual steps remain the source of truth for user-visible acceptance.

## Fresh-profile setup

Run the extension from a temporary Firefox profile:

```bash
npx web-ext run \
  --source-dir firefox \
  --firefox-binary firefox \
  --url https://github.com/OWNER/REPOSITORY/pull/NUMBER/files
```

If the pull request requires authentication, sign in to the temporary profile before testing. Alternatively, open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose `firefox/manifest.json`.

Start a fresh OMP process after the native host is installed. Keep its prompt visible.

## Test cases

### 1. Context-menu delivery

1. Open the pull request's **Files changed** tab.
2. Select one or more lines of source code.
3. Open the Firefox page context menu.
4. Choose **Send selection and link to OMP**.
5. Inspect the active OMP prompt.

Expected:

- The prompt contains `# OMP Agent Handoff`.
- It contains a `## GitHub` section.
- It contains the selected source text in a fenced block.
- It contains a GitHub pull-request or line/permalink URL.
- The packet appears once in the active OMP session.
- Firefox does not display a token or local bridge path.

### 2. Keyboard-shortcut delivery

1. Select different source text on the same pull request.
2. Press the configured **Send selected GitHub context to OMP** shortcut. The suggested default is `Ctrl+Alt+K` on Linux and Windows, or `Command+Alt+K` on macOS.
3. Inspect the OMP prompt.

Expected: the same packet shape and single insertion as the context-menu path. The shortcut and context menu must capture the current selection, not the previous test selection.

### 3. Link metadata

1. Select a line or range with GitHub's line/permalink link available.
2. Invoke the context-menu action.
3. Inspect the `## GitHub` location and the inserted URL.

Expected: the most specific available HTTP(S) GitHub link is used. If no line link is available, the pull-request page URL is used.

### 4. Clipboard fallback

1. Stop OMP or temporarily move the native-host manifest out of `~/.mozilla/native-messaging-hosts/`.
2. Select source text on a pull request.
3. Invoke the shortcut or context-menu action.
4. Paste into a text editor.
5. Restore the native-host manifest and restart OMP.

Expected:

- Firefox reports that the OMP host is unavailable and context was copied.
- The clipboard contains the exact packet that automatic delivery would have sent.
- No partial packet or stale selection is copied.

### 5. Unsupported and empty selections

1. On a GitHub issue or non-GitHub page, invoke the shortcut.
2. On a supported pull-request page, invoke the action with no selected text.

Expected: no request is sent and a clear user-facing error appears. Existing clipboard contents remain unchanged for rejected input.

### 6. Multiple OMP sessions

1. Start two OMP sessions.
2. Explicitly claim one with `/ide`.
3. Send a Firefox context packet.
4. Switch the active OMP session and repeat.

Expected: each packet is inserted once into the currently claimed session. No packet is sent to both sessions.

## Result reporting

Record the Firefox version, OMP version, extension version, operating system, and native-host installation path without recording tokens or selected sensitive source text.

Use one result per test case:

- **PASS** — every expected observable behavior occurred.
- **FAIL** — the flow ran but an expected behavior was wrong; include the exact step and visible result.
- **BLOCKED** — the environment prevented the test from running, such as missing Firefox, unavailable GitHub access, missing native host, or Selenium Manager unable to obtain geckodriver.

A release is not interactive-QA complete until test cases 1, 2, and 4 pass in a fresh Firefox profile.
