import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
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

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
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
      delivery: "paste",
      prompt: "@src/example.ts#L1C1 ",
    })

    assert.equal(response.status, 200)
    assert.deepEqual(pastedPrompts, ["@src/example.ts#L1C1 "])

    await handlers.get("session_shutdown")()
    await assert.rejects(fs.stat(stateFile))
  })
})

test("OMP bridge waits for slow delayed end-append before forcing repaint", async () => {
  await withBridge(BASE_PORT + 20, async ({ handlers, stateFile }) => {
    const prompt = "@src/example.ts#L2C3 "
    const beforeText = `${"draft ".repeat(500)}tail`
    let editorText = beforeText
    let renderedText = beforeText
    let pasteSettled = false

    await handlers.get("session_start")({}, {
      hasUI: true,
      ui: {
        notify() {},
        async getEditorText() {
          return editorText
        },
        async setEditorText(value) {
          editorText = value
          if (pasteSettled) {
            renderedText = value
          }
        },
        pasteToEditor(value) {
          setTimeout(() => {
            editorText = `${beforeText}${value}`
            pasteSettled = true
          }, 25)
        },
      },
    })

    const state = JSON.parse(await fs.readFile(stateFile, "utf8"))
    const response = await postContext(state, {
      delivery: "paste",
      prompt,
    })

    assert.equal(response.status, 200)
    assert.equal(editorText, `${beforeText}${prompt}`)
    assert.equal(renderedText, `${beforeText}${prompt}`)
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
          if (value !== editorText) {
            renderedText = value
            editorText = value
          }
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

test("OMP bridge waits for delayed end-append before forcing repaint", async () => {
  await withBridge(BASE_PORT + 2, async ({ handlers, stateFile }) => {
    const prompt = "@src/example.ts#L5C6 "
    const beforeText = `${"draft ".repeat(500)}tail`
    let editorText = beforeText
    let renderedText = beforeText
    let pasteSettled = false

    await handlers.get("session_start")({}, {
      hasUI: true,
      ui: {
        notify() {},
        async getEditorText() {
          return editorText
        },
        async setEditorText(value) {
          editorText = value
          if (pasteSettled) {
            renderedText = value
          }
        },
        pasteToEditor(value) {
          void nextTick()
            .then(nextTick)
            .then(() => {
              editorText = `${beforeText}${value}`
              pasteSettled = true
            })
        },
      },
    })

    const state = JSON.parse(await fs.readFile(stateFile, "utf8"))
    const response = await postContext(state, {
      delivery: "paste",
      prompt,
    })
    await nextTick()
    await nextTick()
    await nextTick()

    assert.equal(response.status, 200)
    assert.equal(editorText, `${beforeText}${prompt}`)
    assert.equal(renderedText, `${beforeText}${prompt}`)
  })
})

test("OMP bridge appends pasted prompt when immediate readback is stale", async () => {
  await withBridge(BASE_PORT + 3, async ({ handlers, stateFile }) => {
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
  await withBridge(BASE_PORT + 4, async ({ handlers, stateFile }) => {
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
