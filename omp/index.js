import { unwatchFile, watch, watchFile } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, basename, join } from "node:path"
import { fileURLToPath } from "node:url"

import { createBridgeRuntime } from "./bridge-runtime.js"

const PLUGIN_NAME = "omp-vscode-context"
const PLUGINS_LOCK_FILE = join(process.env.HOME ?? "", ".omp", "plugins", "omp-plugins.lock.json")
const PACKAGE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json")

let activeContext
let bridge
let focusUnsubscribe
let focusSettingsWatcher
let focusSettingsRefreshTimer

export default function ompSendContextExtension(pi) {
  pi.setLabel("Send Context to OMP")

  pi.registerFlag("claim-ide-context-on-focus", {
    description: "On Linux, claim context when this terminal gains focus",
    type: "boolean",
    default: false,
  })

  pi.registerCommand("ide", {
    description: "Route context to this OMP terminal",
    handler: async (args, ctx) => {
      activeContext = ctx
      await ensureServer()
      if (args[0] === "status") {
        ctx.ui.notify(`Send Context to OMP ${bridge.version} is listening on ${bridge.endpoint}.`, "info")
        return
      }
      if (await claimActiveBridge({ force: true })) {
        ctx.ui.notify(`Context will target this terminal via ${bridge.endpoint}.`, "info")
      }
    },
  })

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx
    await ensureServer()
    await claimActiveBridge()
    await refreshFocusClaiming(pi)
    watchFocusSettings(pi)
  })

  pi.on("session_switch", async (_event, ctx) => {
    activeContext = ctx
    await ensureServer()
    await claimActiveBridge({ force: true })
  })

  pi.on("session_shutdown", async () => {
    stopFocusSettingsWatcher()
    disableFocusClaiming()
    activeContext = undefined
    await closeServer()
  })
}

async function refreshFocusClaiming(pi) {
  if (process.platform !== "linux" || activeContext === undefined) {
    return
  }

  const setting = await readFocusClaimingSetting()
  if (pi.getFlag("claim-ide-context-on-focus") === true || setting === true) {
    enableFocusClaiming(activeContext)
  } else if (setting === false) {
    disableFocusClaiming()
  }
}

async function readFocusClaimingSetting() {
  try {
    const config = JSON.parse(await readFile(PLUGINS_LOCK_FILE, "utf8"))
    return config.settings?.[PLUGIN_NAME]?.claimIdeContextOnFocus === true
  } catch (error) {
    return error?.code === "ENOENT" ? false : undefined
  }
}

function watchFocusSettings(pi) {
  if (process.platform !== "linux" || pi.getFlag("claim-ide-context-on-focus") === true || focusSettingsWatcher !== undefined) {
    return
  }

  const refresh = () => {
    clearTimeout(focusSettingsRefreshTimer)
    focusSettingsRefreshTimer = setTimeout(() => {
      void refreshFocusClaiming(pi)
    }, 25)
  }

  try {
    focusSettingsWatcher = watch(dirname(PLUGINS_LOCK_FILE), { persistent: false }, (_event, filename) => {
      if (filename !== null && basename(filename.toString()) !== basename(PLUGINS_LOCK_FILE)) {
        return
      }
      refresh()
    })
  } catch {
    watchFile(PLUGINS_LOCK_FILE, { persistent: false, interval: 100 }, refresh)
    focusSettingsWatcher = {
      close() {
        unwatchFile(PLUGINS_LOCK_FILE, refresh)
      },
    }
  }
}

function stopFocusSettingsWatcher() {
  focusSettingsWatcher?.close()
  focusSettingsWatcher = undefined
  clearTimeout(focusSettingsRefreshTimer)
  focusSettingsRefreshTimer = undefined
}

function enableFocusClaiming(ctx) {
  if (process.platform !== "linux" || !ctx.hasUI || focusUnsubscribe !== undefined) {
    return
  }

  if (typeof ctx.ui?.onTerminalInput !== "function") {
    ctx.ui.notify("Claim IDE context on focus requires OMP 16.5.1 or newer.", "warning")
    return
  }

  focusUnsubscribe = ctx.ui.onTerminalInput(handleFocusInput)
  process.stdout.write("\x1b[?1004h")
}

function disableFocusClaiming() {
  if (focusUnsubscribe === undefined) {
    return
  }
  focusUnsubscribe()
  focusUnsubscribe = undefined
  process.stdout.write("\x1b[?1004l")
}

function handleFocusInput(data) {
  let focused = false
  const forwarded = data.replace(/\x1b\[([IO])/g, (_report, state) => {
    if (state === "I") {
      focused = true
    }
    return ""
  })

  if (focused) {
    void claimActiveBridge({ force: true }).catch(() => {})
  }
  return forwarded.length > 0 ? { data: forwarded } : { consume: true }
}

async function ensureServer() {
  if (bridge === undefined) {
    bridge = createBridgeRuntime({
      deliverPrompt: pasteToPromptEditor,
      notify(message, level) {
        activeContext?.ui.notify(message, level)
      },
      packageFile: PACKAGE_FILE,
    })
  }
  await bridge.start()
}

async function claimActiveBridge(options) {
  return bridge?.claim(options) ?? false
}

async function pasteToPromptEditor(prompt) {
  if (!activeContext?.hasUI) {
    throw new Error("No active OMP prompt editor available")
  }

  const ui = activeContext.ui
  if (typeof ui?.pasteToEditor === "function") {
    await ui.pasteToEditor(prompt)
    if (!prompt.endsWith(" ")) {
      await ui.pasteToEditor(" ")
    }
    return
  }
  if (typeof ui?.setEditorText !== "function") {
    throw new Error("No active OMP prompt editor available")
  }

  const beforePasteText = typeof ui.getEditorText === "function" ? await ui.getEditorText() : ""
  await ui.setEditorText(`${beforePasteText}${prompt.endsWith(" ") ? prompt : `${prompt} `}`)
}

async function closeServer() {
  await bridge?.close()
  bridge = undefined
}
