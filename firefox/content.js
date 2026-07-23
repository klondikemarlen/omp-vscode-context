browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "capture-context") {
    reportDebug("capture:start")
    return Promise.resolve(captureContext())
  }
  if (message?.type === "copy-context") {
    return copyText(message.text).then(() => undefined)
  }
  if (message?.type === "notify") {
    showNotification(message.message)
  }
})

function captureContext() {
  const selection = window.getSelection()
  const anchor = selection?.anchorNode?.parentElement?.closest?.("a[href]")
  reportDebug(selection?.toString().trim().length > 0 ? "capture:selection-present" : "capture:selection-empty")
  return {
    selectionText: selection?.toString() ?? "",
    linkUrl: anchor?.href,
    pageUrl: window.location.href,
    title: document.title,
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    reportDebug("clipboard:api-succeeded")
    return
  } catch {
    reportDebug("clipboard:api-failed")
  }

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.append(textarea)
  textarea.select()
  try {
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard command returned false.")
    }
    reportDebug("clipboard:fallback-succeeded")
  } catch {
    reportDebug("clipboard:fallback-failed")
    throw new Error("Clipboard write failed.")
  } finally {
    textarea.remove()
  }
}

function reportDebug(event) {
  void browser.runtime.sendMessage({ type: "debug-event", event }).catch(() => {})
}

function showNotification(message) {
  const notification = document.createElement("div")
  notification.textContent = message
  notification.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;padding:10px 14px;border-radius:6px;background:#24292f;color:#fff;font:13px system-ui,sans-serif;box-shadow:0 2px 8px #0006"
  document.body.append(notification)
  setTimeout(() => notification.remove(), 3500)
}
