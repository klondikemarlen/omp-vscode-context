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
      prompt: "@src/example.ts#L1C1 ",
    })

    assert.equal(response.status, 200)
    assert.deepEqual(pastedPrompts, ["@src/example.ts#L1C1 "])

    await handlers.get("session_shutdown")()
    await assert.rejects(fs.stat(stateFile))
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
      prompt: "@src/example.ts#L1C1 ",
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
