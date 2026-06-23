import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const TEST_PORT = "48731"

test("OMP bridge accepts authorized context and pastes into editor", async () => {
  const originalHome = process.env.HOME
  const originalPort = process.env.OMP_CONTEXT_BRIDGE_PORT
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vscode-context-"))
  process.env.HOME = homeDirectory
  process.env.OMP_CONTEXT_BRIDGE_PORT = TEST_PORT

  try {
    const moduleUrl = pathToFileURL(path.resolve("omp/index.js"))
    const extensionModule = await import(`${moduleUrl.href}?bridge-test=${Date.now()}`)
    const handlers = new Map()
    const commands = new Map()
    const pastedPrompts = []

    const pi = {
      setLabel() {},
      on(eventName, handler) {
        handlers.set(eventName, handler)
      },
      registerCommand(commandName, command) {
        commands.set(commandName, command)
      },
      async sendUserMessage() {},
    }

    const ctx = {
      hasUI: true,
      ui: {
        notify() {},
        async pasteToEditor(prompt) {
          pastedPrompts.push(prompt)
        },
      },
    }

    extensionModule.default(pi)
    await handlers.get("session_start")({}, ctx)

    const stateFile = path.join(homeDirectory, ".omp", "agent", "editor-context-bridge.json")
    const state = JSON.parse(await fs.readFile(stateFile, "utf8"))
    assert.equal(state.version, "1.0.0")
    assert.equal(typeof state.instanceId, "string")
    assert.equal(commands.has("vscode-context-here"), true)
    assert.equal(commands.has("vscode-context-status"), true)
    const response = await fetch(`${state.endpoint}/context`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({
        delivery: "paste",
        prompt: "@src/example.ts#L1C1 ",
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(pastedPrompts, ["@src/example.ts#L1C1 "])

    await handlers.get("session_shutdown")()
    await assert.rejects(fs.stat(stateFile))
  } finally {
    process.env.HOME = originalHome
    process.env.OMP_CONTEXT_BRIDGE_PORT = originalPort
    await fs.rm(homeDirectory, {
      recursive: true,
      force: true,
    })
  }
})
