browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "capture-context") {
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
    return
  } catch {}

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.append(textarea)
  textarea.select()
  document.execCommand("copy")
  textarea.remove()
}

function showNotification(message) {
  const notification = document.createElement("div")
  notification.textContent = message
  notification.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;padding:10px 14px;border-radius:6px;background:#24292f;color:#fff;font:13px system-ui,sans-serif;box-shadow:0 2px 8px #0006"
  document.body.append(notification)
  setTimeout(() => notification.remove(), 3500)
}
