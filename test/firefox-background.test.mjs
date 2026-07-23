import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import vm from "node:vm"

const backgroundSource = await fs.readFile(new URL("../firefox/background.js", import.meta.url), "utf8")

function event() {
  const listeners = []
  return {
    addListener(listener) {
      listeners.push(listener)
    },
    async emit(...args) {
      await Promise.all(listeners.map(listener => listener(...args)))
    },
  }
}

async function runFlow(nativeResponse) {
  const events = {
    installed: event(),
    menuClicked: event(),
    browserAction: event(),
    messages: event(),
    commands: event(),
  }
  const messages = []
  const logs = []
  let debugLogging = false
  const browser = {
    runtime: {
      onInstalled: events.installed,
      onMessage: events.messages,
      sendNativeMessage: async () => nativeResponse,
      getManifest: () => ({ version: "1.7.1" }),
    },
    menus: {
      create() {},
      onClicked: events.menuClicked,
    },
    browserAction: {
      onClicked: events.browserAction,
    },
    commands: {
      onCommand: events.commands,
    },
    storage: {
      local: {
        async get() {
          return { debugLogging }
        },
        async set(values) {
          debugLogging = values.debugLogging
        },
      },
    },
    tabs: {
      async query() {
        return [{ id: 42 }]
      },
      async sendMessage(_tabId, message) {
        messages.push(message)
        if (message.type === "capture-context") {
          return {
            selectionText: "const value = 1",
            pageUrl: "https://github.com/org/repo/pull/42/files",
            title: "Test pull request",
          }
        }
        return undefined
      },
    },
  }

  vm.runInNewContext(backgroundSource, {
    browser,
    console: { info: (...args) => logs.push(args.join(" ")) },
    ompSendContext: {
      createEnvelope(capture) {
        return { prompt: `selected:${capture.selectionText}` }
      },
    },
    setTimeout,
    clearTimeout,
    Date,
  })

  await events.browserAction.emit()
  await events.commands.emit("send-context")
  await new Promise(resolve => setTimeout(resolve, 10))
  return { messages, logs }
}

test("Firefox client falls back when the native host rejects delivery", async () => {
  const result = await runFlow({ ok: false, error: "Invalid OMP bridge state" })

  assert.ok(result.messages.some(message => message.type === "copy-context"))
  assert.ok(result.logs.some(entry => entry.includes("native:failed:bridge-rejected")))
})

test("Firefox client does not fall back after native delivery succeeds", async () => {
  const result = await runFlow({ ok: true })

  assert.ok(result.logs.some(entry => entry.includes("native:succeeded")))
  assert.equal(result.messages.some(message => message.type === "copy-context"), false)
})
