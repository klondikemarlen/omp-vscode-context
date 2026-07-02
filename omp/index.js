import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_PORT = Number.parseInt(process.env.OMP_CONTEXT_BRIDGE_PORT ?? "47687", 10)
const HOST = "127.0.0.1"
const MAX_PORT_ATTEMPTS = 20
const MAX_BODY_BYTES = 2 * 1024 * 1024
const HEALTH_TIMEOUT_MILLISECONDS = 500
const PASTE_READBACK_TIMEOUT_MILLISECONDS = 100
const STATE_FILE = join(homedir(), ".omp", "agent", "editor-context-bridge.json")
const PACKAGE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json")

let activeContext
let instanceId
let packageVersion
let server
let serverPort
let token
let serverEndpoint

export default function ompVscodeContextExtension(pi) {
  pi.setLabel("VS Code Context Bridge")

  pi.registerCommand("ide", {
    description: "Route VS Code editor context to this OMP terminal",
    handler: async (_args, ctx) => {
      activeContext = ctx
      await ensureServer(pi, ctx)
      if (await claimActiveBridge({ force: true })) {
        ctx.ui.notify(`VS Code context will target this terminal via ${serverEndpoint}.`, "info")
      }
    },
  })

  pi.registerCommand("ide-status", {
    description: "Show VS Code context bridge endpoint and version",
    handler: async (_args, ctx) => {
      await ensureServer(pi, ctx)
      ctx.ui.notify(`VS Code Context Bridge ${packageVersion} is listening on ${serverEndpoint}.`, "info")
    },
  })

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx
    await ensureServer(pi, ctx)
    await claimActiveBridge()
  })

  pi.on("session_switch", async (_event, ctx) => {
    activeContext = ctx
    await ensureServer(pi, ctx)
    await claimActiveBridge({ force: true })
  })

  pi.on("session_shutdown", async () => {
    activeContext = undefined
    await closeServer()
  })
}

async function ensureServer(pi, ctx) {
  if (server !== undefined) {
    return
  }

  instanceId = randomBytes(16).toString("hex")
  await ensurePackageVersion()

  token = randomBytes(32).toString("hex")

  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const port = DEFAULT_PORT + offset
    const candidateServer = createServer((request, response) => {
      void handleRequest(pi, request, response)
    })

    try {
      await listen(candidateServer, port)
      server = candidateServer
      serverPort = port
      serverEndpoint = `http://${HOST}:${port}`
      return
    } catch (error) {
      candidateServer.close()
      if (!isAddressInUse(error)) {
        throw error
      }
    }
  }

  ctx.ui.notify("VS Code context bridge could not find an available local port.", "error")
}

function listen(candidateServer, port) {
  return new Promise((resolve, reject) => {
    candidateServer.once("error", reject)
    candidateServer.listen(port, HOST, () => {
      candidateServer.off("error", reject)
      resolve()
    })
  })
}

async function handleRequest(pi, request, response) {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, {
      ok: true,
      instanceId,
      endpoint: serverEndpoint,
    })
    return
  }

  if (request.method !== "POST" || request.url !== "/context") {
    sendJson(response, 404, {
      error: "Not found",
    })
    return
  }

  if (!isAuthorized(request)) {
    sendJson(response, 401, {
      error: "Unauthorized",
    })
    return
  }

  let body
  try {
    body = await readJsonBody(request)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body"
    sendJson(response, 400, {
      error: message,
    })
    return
  }

  if (!isContextRequest(body)) {
    sendJson(response, 400, {
      error: "Expected a context request with a prompt string",
    })
    return
  }

  try {
    await deliverContext(pi, body)
    sendJson(response, 200, {
      ok: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to deliver context"
    sendJson(response, 500, {
      error: message,
    })
  }
}

function isAuthorized(request) {
  if (token === undefined) {
    return true
  }

  return request.headers.authorization === `Bearer ${token}`
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []

    request.on("data", (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large"))
        request.destroy()
        return
      }

      chunks.push(chunk)
    })

    request.on("end", () => {
      try {
        const rawBody = Buffer.concat(chunks).toString("utf8")
        resolve(JSON.parse(rawBody))
      } catch {
        reject(new Error("Request body is not valid JSON"))
      }
    })

    request.on("error", reject)
  })
}

function isContextRequest(value) {
  if (typeof value !== "object" || value === null) {
    return false
  }

  return typeof value.prompt === "string" && value.prompt.length > 0
}

async function deliverContext(pi, body) {
  if (body.delivery === "send") {
    await pi.sendUserMessage(body.prompt, { deliverAs: "steer" })
    return
  }

  if (body.delivery === "nextTurn") {
    await pi.sendUserMessage(body.prompt, { deliverAs: "nextTurn" })
    return
  }

  if (await pasteToPromptEditor(body.prompt)) {
    return
  }

  await pi.sendUserMessage(body.prompt, { deliverAs: "nextTurn" })
}

async function pasteToPromptEditor(prompt) {
  if (!activeContext?.hasUI) {
    return false
  }

  const ui = activeContext.ui
  const canSetEditorText = typeof ui?.getEditorText === "function"
    && typeof ui?.setEditorText === "function"
  const beforePasteText = canSetEditorText ? await ui.getEditorText() : undefined

  if (typeof ui?.pasteToEditor === "function") {
    await ui.pasteToEditor(prompt)
    await refreshPromptEditor(ui, beforePasteText, prompt)
    return true
  }

  if (!canSetEditorText) {
    return false
  }

  await ui.setEditorText(`${typeof beforePasteText === "string" ? beforePasteText : ""}${prompt}`)
  return true
}

async function refreshPromptEditor(ui, beforePasteText, prompt) {
  if (typeof beforePasteText !== "string") {
    return
  }

  const editorText = await readEditorTextAfterPaste(ui, beforePasteText)
  if (typeof editorText !== "string") {
    return
  }

  const refreshedText = editorText === beforePasteText ? `${editorText}${prompt}` : editorText
  if (refreshedText === beforePasteText) {
    return
  }

  // OMP can accept a paste without repainting until the next keystroke.
  await ui.setEditorText(beforePasteText)
  await ui.setEditorText(refreshedText)
}

async function readEditorTextAfterPaste(ui, beforePasteText) {
  const deadline = Date.now() + PASTE_READBACK_TIMEOUT_MILLISECONDS
  let editorText = await ui.getEditorText()
  while (editorText === beforePasteText && Date.now() < deadline) {
    await nextTick()
    editorText = await ui.getEditorText()
  }
  return editorText
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function claimActiveBridge({ force = false } = {}) {
  if (serverEndpoint === undefined || serverPort === undefined) {
    return false
  }

  if (!force && await hasLiveBridgeOwner()) {
    return false
  }

  await writeStateFile()
  return true
}

async function hasLiveBridgeOwner() {
  const state = await readStateFile()
  if (state?.instanceId === undefined || state.instanceId === instanceId) {
    return false
  }

  return isHealthyEndpoint(state.endpoint, state.instanceId)
}

async function readStateFile() {
  try {
    const state = JSON.parse(await readFile(STATE_FILE, "utf8"))
    if (typeof state.endpoint === "string") {
      return state
    }
  } catch {
  }

  return undefined
}

async function isHealthyEndpoint(endpoint, expectedInstanceId) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MILLISECONDS)

  try {
    const response = await fetch(`${endpoint}/health`, {
      signal: controller.signal,
    })
    if (!response.ok) {
      return false
    }

    const body = await response.json()
    return body?.instanceId === expectedInstanceId
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function writeStateFile() {
  const state = {
    endpoint: serverEndpoint,
    port: serverPort,
    token,
    pid: process.pid,
    instanceId,
    version: packageVersion,
    updatedAt: new Date().toISOString(),
  }

  await mkdir(join(homedir(), ".omp", "agent"), {
    recursive: true,
  })
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  })
}

async function ensurePackageVersion() {
  if (packageVersion !== undefined) {
    return
  }

  const packageContent = await readFile(PACKAGE_FILE, "utf8")
  const packageJson = JSON.parse(packageContent)
  packageVersion = typeof packageJson.version === "string" ? packageJson.version : "unknown"
}

async function closeServer() {
  if (server === undefined) {
    return
  }

  const closingServer = server
  const closingInstanceId = instanceId
  server = undefined
  serverEndpoint = undefined
  serverPort = undefined
  instanceId = undefined
  token = undefined

  await new Promise((resolve) => {
    closingServer.close(() => resolve())
  })

  await removeStateFile(closingInstanceId)
}

async function removeStateFile(closingInstanceId) {
  try {
    const stateContent = await readFile(STATE_FILE, "utf8")
    const state = JSON.parse(stateContent)
    if (state.instanceId !== closingInstanceId) {
      return
    }
  } catch {
    return
  }

  await rm(STATE_FILE, {
    force: true,
  })
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
  })
  response.end(JSON.stringify(body))
}

function isAddressInUse(error) {
  return typeof error === "object" && error !== null && error.code === "EADDRINUSE"
}
