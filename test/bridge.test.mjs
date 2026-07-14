import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import { pathToFileURL } from "node:url"
import { syncBuiltinESMExports } from "node:module"

const BASE_PORT = 48731

async function withBridge(port, run, { flags = {}, pluginSettings = {} } = {}) {
  const originalHome = process.env.HOME
  const originalPort = process.env.OMP_CONTEXT_BRIDGE_PORT
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vscode-context-"))
  process.env.HOME = homeDirectory
  process.env.OMP_CONTEXT_BRIDGE_PORT = String(port)

  const handlers = new Map()
  const commands = new Map()
  const registeredFlags = new Map()
  const sentMessages = []

  try {
    const moduleUrl = pathToFileURL(path.resolve("omp/index.js"))
    const extensionModule = await import(`${moduleUrl.href}?bridge-test=${port}-${Date.now()}`)
    extensionModule.default({
      registerFlag(name, definition) {
        registeredFlags.set(name, definition)
      },
      getFlag(name) {
        return flags[name]
      },
      getPluginSettings() {
        return pluginSettings
      },
      setLabel() {},
      on(eventName, handler) {
        handlers.set(eventName, handler)
      },
      registerCommand(commandName, command) {
        commands.set(commandName, command)
      },
      async sendUserMessage(prompt, options) {
        sentMessages.push({ prompt, options })
      },
    })

    await run({
      commands,
      handlers,
      homeDirectory,
      sentMessages,
      stateFile: path.join(homeDirectory, ".omp", "agent", "editor-context-bridge.json"),
      registeredFlags,
    })
  } finally {
    await handlers.get("session_shutdown")?.()
    process.env.HOME = originalHome
    process.env.OMP_CONTEXT_BRIDGE_PORT = originalPort
    await fs.rm(homeDirectory, {
      recursive: true,
      force: true,
    })
  }
}

async function postContext(state, body) {
  return fetch(`${state.endpoint}/context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.token}`,
    },
    body: JSON.stringify(body),
  })
}


test("OMP bridge accepts authorized context and pastes into editor", async () => {
  await withBridge(BASE_PORT, async ({ commands, handlers, stateFile }) => {
    const pastedPrompts = []
    const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"))

    await handlers.get("session_start")({}, {
      hasUI: true,
      ui: {
        notify() {},
        async pasteToEditor(prompt) {
          pastedPrompts.push(prompt)
        },
      },
    })

    const state = JSON.parse(await fs.readFile(stateFile, "utf8"))
    assert.equal(state.version, packageJson.version)
    assert.equal(typeof state.instanceId, "string")
    assert.equal(commands.has("ide"), true)
    assert.equal(commands.has("ide-status"), true)

    const response = await postContext(state, {
      prompt: "@src/example.ts#L1C1",
    })

    assert.equal(response.status, 200)
    assert.deepEqual(pastedPrompts, ["@src/example.ts#L1C1", " "])

    const spacedResponse = await postContext(state, {
      prompt: "@src/with-space.ts#L1C1 ",
    })

    assert.equal(spacedResponse.status, 200)
    assert.deepEqual(pastedPrompts, ["@src/example.ts#L1C1", " ", "@src/with-space.ts#L1C1 "])

    await handlers.get("session_shutdown")()
    await assert.rejects(fs.stat(stateFile))
  })
})

test("OMP bridge adds an edit separator after structured Markdown prompts", async () => {
  await withBridge(BASE_PORT + 23, async ({ handlers, stateFile }) => {
    const pastedPrompts = []
    const markdownPrompt = [
      "# OMP Agent Handoff",
      "",
      "## Goal / constraints / verify with",
      "Goal: preserve exact packet body",
      "Verify with: targeted bridge test",
      "",
      "## Active editor",
      "@src/example.ts#L1C1-L2C3 ",
      "",
      "```ts",
      "const value = 1",
      "```",
      "",
      "",
    ].join("\n")

    await handlers.get("session_start")({}, {
      hasUI: true,
      ui: {
        async pasteToEditor(prompt) {
          pastedPrompts.push(prompt)
        },
      },
    })

    const state = JSON.parse(await fs.readFile(stateFile, "utf8"))
    const response = await postContext(state, {
      prompt: markdownPrompt,
    })

    assert.equal(response.status, 200)
    assert.deepEqual(pastedPrompts, [markdownPrompt, " "])
  })
})

test("OMP bridge appends prompt with setEditorText fallback", async () => {
  await withBridge(BASE_PORT + 22, async ({ handlers, stateFile }) => {
    let editorText = "draft "

    await handlers.get("session_start")({}, {
      hasUI: true,
      ui: {
        async getEditorText() {
          return editorText
        },
        async setEditorText(text) {
          editorText = text
        },
      },
    })

    const state = JSON.parse(await fs.readFile(stateFile, "utf8"))
    const response = await postContext(state, {
      prompt: "@src/example.ts#L1C1",
    })

    assert.equal(response.status, 200)
    assert.equal(editorText, "draft @src/example.ts#L1C1 ")
  })
})


test("OMP bridge rejects context when prompt paste is unavailable", async () => {
  await withBridge(BASE_PORT + 21, async ({ handlers, sentMessages, stateFile }) => {
    await handlers.get("session_start")({}, {
      hasUI: false,
    })

    const state = JSON.parse(await fs.readFile(stateFile, "utf8"))
    const response = await postContext(state, {
      prompt: "@src/example.ts#L1C1 ",
    })
    const body = await response.json()

    assert.equal(response.status, 500)
    assert.equal(body.error, "No active OMP prompt editor available")
    assert.deepEqual(sentMessages, [])
  })
})

test("OMP bridge session_start does not steal an existing live bridge", async () => {
  await withBridge(BASE_PORT + 5, async ({ handlers, stateFile }) => {
    const ownerPort = BASE_PORT + 6
    const ownerServer = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json",
      })
      response.end(JSON.stringify({ ok: true, instanceId: "owner-instance" }))
    })
    await new Promise((resolve) => ownerServer.listen(ownerPort, "127.0.0.1", resolve))

    try {
      await fs.mkdir(path.dirname(stateFile), {
        recursive: true,
      })
      await fs.writeFile(stateFile, JSON.stringify({
        endpoint: `http://127.0.0.1:${ownerPort}`,
        token: "owner-token",
        instanceId: "owner-instance",
      }))

      await handlers.get("session_start")({}, {
        hasUI: true,
        ui: {
          notify() {},
        },
      })

      const state = JSON.parse(await fs.readFile(stateFile, "utf8"))
      assert.equal(state.instanceId, "owner-instance")
    } finally {
      await new Promise((resolve) => ownerServer.close(resolve))
    }
  })
})

test("shutdown cannot delete a successor bridge claim", async () => {
  const originalRename = fs.rename
  let stateFile
  let releaseRename
  const allowRename = new Promise((resolve) => {
    releaseRename = resolve
  })
  let renameReachedResolve
  let renameReachedReject
  const renameReached = new Promise((resolve, reject) => {
    renameReachedResolve = resolve
    renameReachedReject = reject
  })
  let renameTimeout

  fs.rename = async (source, destination) => {
    if (source === stateFile && String(destination).includes(".closing")) {
      renameReachedResolve()
      await allowRename
    }
    return originalRename(source, destination)
  }
  syncBuiltinESMExports()

  try {
    await withBridge(BASE_PORT + 10, async ({ handlers, stateFile: bridgeStateFile }) => {
      stateFile = bridgeStateFile
      await handlers.get("session_start")({}, {
        hasUI: true,
        ui: {},
      })

      // Pause after the shutdown has confirmed ownership but before its atomic move.
      const shutdown = handlers.get("session_shutdown")()
      renameTimeout = setTimeout(() => {
        renameReachedReject(new Error("cleanup rename was not reached"))
      }, 1000)
      await renameReached
      clearTimeout(renameTimeout)

      const successorState = {
        endpoint: "http://127.0.0.1:49875",
        instanceId: "successor-instance",
      }
      const successorStateFile = `${stateFile}.successor`
      await fs.writeFile(successorStateFile, JSON.stringify(successorState))
      await originalRename(successorStateFile, stateFile)
      releaseRename()
      await shutdown

      assert.deepEqual(JSON.parse(await fs.readFile(stateFile, "utf8")), successorState)
    })
  } finally {
    fs.rename = originalRename
    syncBuiltinESMExports()
  }
})

test("focus routing is disabled by default", async () => {
  await withBridge(BASE_PORT + 6, async ({ handlers }) => {
    let subscribed = false
    await handlers.get("session_start")({}, {
      hasUI: true,
      ui: {
        onTerminalFocusChange() {
          subscribed = true
          return () => {}
        },
      },
    })

    assert.equal(subscribed, false)
  })
})

test("plugin setting enables focus routing", async () => {
  const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"))
  assert.deepEqual(packageJson.omp.settings.claimIdeContextOnFocus, {
    type: "boolean",
    default: false,
    description: "Claim IDE context automatically when this terminal gains focus.",
  })

  await withBridge(BASE_PORT + 11, async ({ handlers }) => {
    let subscribed = false
    await handlers.get("session_start")({}, {
      hasUI: true,
      ui: {
        onTerminalFocusChange() {
          subscribed = true
          return () => {}
        },
      },
    })

    assert.equal(subscribed, true)
  }, {
    pluginSettings: {
      claimIdeContextOnFocus: true,
    },
  })
})

test("focus routing warns when the runtime cannot report focus", async () => {
  await withBridge(BASE_PORT + 9, async ({ handlers }) => {
    const notifications = []
    await handlers.get("session_start")({}, {
      hasUI: true,
      ui: {
        notify(message, type) {
          notifications.push({ message, type })
        },
      },
    })

    assert.deepEqual(notifications, [{
      message: "Claim IDE context on focus requires a newer OMP runtime.",
      type: "warning",
    }])
  }, {
    flags: {
      "claim-ide-context-on-focus": true,
    },
  })
})

test("focus flag claims the bridge after a terminal focus report", async () => {
  await withBridge(BASE_PORT + 7, async ({ handlers, registeredFlags, stateFile }) => {
    const ownerPort = BASE_PORT + 8
    const ownerServer = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json",
      })
      response.end(JSON.stringify({ ok: true, instanceId: "owner-instance" }))
    })
    await new Promise((resolve) => ownerServer.listen(ownerPort, "127.0.0.1", resolve))

    let focusHandler
    let focusUnsubscribed = false
    try {
      await fs.mkdir(path.dirname(stateFile), {
        recursive: true,
      })
      await fs.writeFile(stateFile, JSON.stringify({
        endpoint: `http://127.0.0.1:${ownerPort}`,
        token: "owner-token",
        instanceId: "owner-instance",
      }))

      await handlers.get("session_start")({}, {
        hasUI: true,
        ui: {
          onTerminalFocusChange(handler) {
            focusHandler = handler
            return () => {
              focusUnsubscribed = true
            }
          },
        },
      })

      assert.deepEqual(registeredFlags.get("claim-ide-context-on-focus"), {
        description: "Claim IDE context when this terminal gains focus",
        type: "boolean",
        default: false,
      })
      assert.equal(JSON.parse(await fs.readFile(stateFile, "utf8")).instanceId, "owner-instance")

      await focusHandler(false)
      assert.equal(JSON.parse(await fs.readFile(stateFile, "utf8")).instanceId, "owner-instance")

      await focusHandler(true)
      assert.equal(JSON.parse(await fs.readFile(stateFile, "utf8")).endpoint, `http://127.0.0.1:${BASE_PORT + 7}`)

      await handlers.get("session_shutdown")()
      assert.equal(focusUnsubscribed, true)
    } finally {
      await new Promise((resolve) => ownerServer.close(resolve))
    }
  }, {
    flags: {
      "claim-ide-context-on-focus": true,
    },
  })
})
