const NATIVE_HOST_NAME = "omp_send_context"
const MENU_ID = "omp-send-context"

browser.runtime.onInstalled.addListener(() => {
  browser.menus.create({
    id: MENU_ID,
    title: "Send selection and link to OMP",
    contexts: ["selection", "link"],
    documentUrlPatterns: ["https://github.com/*"],
  })
})

browser.menus.onClicked.addListener((info, tab) => {
  void sendMenuContext(info, tab)
})

browser.commands.onCommand.addListener((command) => {
  if (command !== "send-context") {
    return
  }
  void sendActiveContext()
})

async function sendMenuContext(info, tab) {
  try {
    const pageUrl = info.pageUrl ?? tab?.url ?? ""
    const envelope = ompSendContext.createEnvelope({
      selectionText: info.selectionText ?? "",
      linkUrl: info.linkUrl,
      pageUrl,
      title: tab?.title,
    })
    await deliver(envelope, tab?.id)
  } catch (error) {
    await notify(tab?.id, errorMessage(error))
  }
}

async function sendActiveContext() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined) {
    return
  }

  try {
    const capture = await browser.tabs.sendMessage(tab.id, { type: "capture-context" })
    const envelope = ompSendContext.createEnvelope(capture)
    await deliver(envelope, tab.id)
  } catch (error) {
    await notify(tab.id, errorMessage(error))
  }
}

async function deliver(envelope, tabId) {
  try {
    await browser.runtime.sendNativeMessage(NATIVE_HOST_NAME, envelope)
    await notify(tabId, "Context sent to OMP.")
  } catch (error) {
    try {
      await browser.tabs.sendMessage(tabId, { type: "copy-context", text: envelope.prompt })
      await notify(tabId, "OMP host unavailable; context copied to the clipboard.")
    } catch {
      throw error
    }
  }
}

async function notify(tabId, message) {
  if (tabId === undefined) {
    return
  }
  try {
    await browser.tabs.sendMessage(tabId, { type: "notify", message })
  } catch {}
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "Unable to send context to OMP."
}
