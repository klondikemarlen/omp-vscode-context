import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const BASE_PORT = 48731

async function withBridge(port, run) {
  const originalHome = process.env.HOME
  const originalPort = process.env.OMP_CONTEXT_BRIDGE_PORT
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vscode-context-"))
  process.env.HOME = homeDirectory
  process.env.OMP_CONTEXT_BRIDGE_PORT = String(port)

  const handlers = new Map()
  const commands = new Map()
  const sentMessages = []

  try {
    const moduleUrl = pathToFileURL(path.resolve("omp/index.js"))
    const extensionModule = await import(`${moduleUrl.href}?bridge-test=${port}-${Date.now()}`)
    extensionModule.default({
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
    assert.equal(commands.has("vscode-context-here"), true)
    assert.equal(commands.has("vscode-context-status"), true)

    const response = await postContext(state, {
      delivery: "paste",
      prompt: "@src/example.ts#L1C1 ",
    })

    assert.equal(response.status, 200)
    assert.deepEqual(pastedPrompts, ["@src/example.ts#L1C1 "])

    await handlers.get("session_shutdown")()
    await assert.rejects(fs.stat(stateFile))
  })
})

test("OMP bridge refreshes prompt text after paste when editor APIs are available", async () => {
  await withBridge(BASE_PORT + 1, async ({ handlers, stateFile }) => {
    const prompt = "@src/example.ts#L2C3 "
    let editorText = "draft middle"
    let renderedText = ""

    await handlers.get("session_start")({}, {
      hasUI: true,
      ui: {
        notify() {},
        async getEditorText() {
          return editorText
        },
        async setEditorText(value) {
          renderedText = value
          editorText = value
        },
        async pasteToEditor(value) {
          editorText = `draft ${value}middle`
        },
      },
    })

    const state = JSON.parse(await fs.readFile(stateFile, "utf8"))
    const response = await postContext(state, {
      delivery: "paste",
      prompt,
    })

    assert.equal(response.status, 200)
    assert.equal(renderedText, "draft @src/example.ts#L2C3 middle")
  })
})

test("OMP bridge appends pasted prompt when immediate readback is stale", async () => {
  await withBridge(BASE_PORT + 2, async ({ handlers, stateFile }) => {
    let editorText = "draft "

    await handlers.get("session_start")({}, {
      hasUI: true,
      ui: {
        notify() {},
        async getEditorText() {
          return editorText
        },
        async setEditorText(value) {
          editorText = value
        },
        async pasteToEditor() {},
      },
    })

    const state = JSON.parse(await fs.readFile(stateFile, "utf8"))
    const response = await postContext(state, {
      delivery: "paste",
      prompt: "@src/example.ts#L3C4 ",
    })

    assert.equal(response.status, 200)
    assert.equal(editorText, "draft @src/example.ts#L3C4 ")
  })
})

test("OMP bridge still appends when stale readback already contains prompt", async () => {
  await withBridge(BASE_PORT + 3, async ({ handlers, stateFile }) => {
    const prompt = "@src/example.ts#L4C5 "
    let editorText = `draft ${prompt}`

    await handlers.get("session_start")({}, {
      hasUI: true,
      ui: {
        notify() {},
        async getEditorText() {
          return editorText
        },
        async setEditorText(value) {
          editorText = value
        },
        async pasteToEditor() {},
      },
    })

    const state = JSON.parse(await fs.readFile(stateFile, "utf8"))
    const response = await postContext(state, {
      delivery: "paste",
      prompt,
    })

    assert.equal(response.status, 200)
    assert.equal(editorText, `draft ${prompt}${prompt}`)
  })
})
