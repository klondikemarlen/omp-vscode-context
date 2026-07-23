const NATIVE_HOST_NAME = "omp_send_context"
const MENU_ID = "omp-send-context"
const DEBUG_MENU_ID = "omp-send-context-debug"
const DEBUG_STORAGE_KEY = "debugLogging"
const MAX_DEBUG_ENTRIES = 100

const debugEntries = []

browser.runtime.onInstalled.addListener(() => {
  browser.menus.create({
    id: MENU_ID,
    title: "Send selection and link to OMP",
    contexts: ["selection", "link"],
    documentUrlPatterns: ["https://github.com/*"],
  })
  browser.menus.create({
    id: DEBUG_MENU_ID,
    title: "Copy OMP Send Context debug log",
    contexts: ["all"],
    documentUrlPatterns: ["https://github.com/*"],
  })
})

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === DEBUG_MENU_ID) {
    void copyDebugLog(tab?.id)
    return
  }
  void sendMenuContext(info, tab)
})

browser.browserAction.onClicked.addListener(() => {
  void toggleDebugLogging()
})

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "debug-event" && typeof message.event === "string") {
    void recordDebug(`content:${message.event}`)
  }
})

browser.commands.onCommand.addListener((command) => {
  if (command !== "send-context") {
    return
  }
  void recordDebug("shortcut:received")
  void sendActiveContext()
})

async function sendMenuContext(info, tab) {
  await recordDebug("menu:received")
  try {
    const pageUrl = info.pageUrl ?? tab?.url ?? ""
    const envelope = ompSendContext.createEnvelope({
      selectionText: info.selectionText ?? "",
      linkUrl: info.linkUrl,
      pageUrl,
      title: tab?.title,
    })
    await recordDebug("envelope:created")
    await deliver(envelope, tab?.id)
  } catch (error) {
    await recordDebug("menu:failed")
    await notify(tab?.id, errorMessage(error))
  }
}

async function sendActiveContext() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined) {
    await recordDebug("shortcut:no-active-tab")
    return
  }

  try {
    await recordDebug("capture:requested")
    const capture = await browser.tabs.sendMessage(tab.id, { type: "capture-context" })
    await recordDebug("capture:received")
    const envelope = ompSendContext.createEnvelope(capture)
    await recordDebug("envelope:created")
    await deliver(envelope, tab.id)
  } catch (error) {
    await recordDebug("shortcut:failed")
    await notify(tab.id, errorMessage(error))
  }
}

async function deliver(envelope, tabId) {
  await recordDebug("native:starting")
  try {
    const response = await browser.runtime.sendNativeMessage(NATIVE_HOST_NAME, envelope)
    if (response?.ok !== true) {
      throw new Error(response?.error ?? "Native host rejected the context.")
    }
    await recordDebug("native:succeeded")
    await notify(tabId, "Context sent to OMP.")
  } catch (error) {
    await recordDebug(`native:failed:${nativeErrorCode(error)}`)
    try {
      await recordDebug("clipboard:starting")
      await browser.tabs.sendMessage(tabId, { type: "copy-context", text: envelope.prompt })
      await recordDebug("clipboard:succeeded")
      await notify(tabId, "OMP host unavailable; context copied to the clipboard.")
    } catch {
      await recordDebug("clipboard:failed")
      throw new Error("Unable to deliver context to OMP or the clipboard.")
    }
  }
}

function nativeErrorCode(error) {
  const message = String(error?.message ?? "").toLowerCase()
  if (message.includes("no such native application") || message.includes("not found") || message.includes("native host")) {
    return "host-unavailable"
  }
  if (message.includes("permission") || message.includes("access")) {
    return "host-permission"
  }
  if (message.includes("bridge") || message.includes("loopback")) {
    return "bridge-rejected"
  }
  return "unknown"
}

async function toggleDebugLogging() {
  const enabled = await readDebugEnabled()
  await browser.storage.local.set({ [DEBUG_STORAGE_KEY]: !enabled })
  debugEntries.length = 0
  await recordDebug(!enabled ? "debug:enabled" : "debug:disabled")
  await notifyActiveTab(`Debug logging ${!enabled ? "enabled" : "disabled"}.`)
}

async function copyDebugLog(tabId) {
  const report = [
    "OMP Send Context debug log",
    `Extension version: ${browser.runtime.getManifest().version}`,
    `Debug logging: ${await readDebugEnabled() ? "enabled" : "disabled"}`,
    ...debugEntries,
  ].join("\n")
  try {
    await browser.tabs.sendMessage(tabId, { type: "copy-context", text: report })
    await notify(tabId, "Debug log copied to the clipboard.")
  } catch {
    await recordDebug("debug-export:failed")
  }
}

async function notifyActiveTab(message) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  await notify(tab?.id, message)
}

async function notify(tabId, message) {
  if (tabId === undefined) {
    return
  }
  try {
    await browser.tabs.sendMessage(tabId, { type: "notify", message })
  } catch {
    await recordDebug("notify:failed")
  }
}

async function readDebugEnabled() {
  try {
    const values = await browser.storage.local.get(DEBUG_STORAGE_KEY)
    return values[DEBUG_STORAGE_KEY] === true
  } catch {
    return false
  }
}

async function recordDebug(event) {
  if (!await readDebugEnabled()) {
    return
  }
  const entry = `${new Date().toISOString()} ${event}`
  debugEntries.push(entry)
  if (debugEntries.length > MAX_DEBUG_ENTRIES) {
    debugEntries.shift()
  }
  console.info(`[OMP Send Context] ${entry}`)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "Unable to send context to OMP."
}
