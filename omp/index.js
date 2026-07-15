import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { watch } from "node:fs"
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_PORT = Number.parseInt(process.env.OMP_CONTEXT_BRIDGE_PORT ?? "47687", 10)
const HOST = "127.0.0.1"
const MAX_PORT_ATTEMPTS = 20
const MAX_BODY_BYTES = 2 * 1024 * 1024
const HEALTH_TIMEOUT_MILLISECONDS = 500
const STATE_FILE = join(homedir(), ".omp", "agent", "editor-context-bridge.json")
const PACKAGE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json")
const PLUGINS_LOCK_FILE = join(homedir(), ".omp", "plugins", "omp-plugins.lock.json")
const PLUGIN_NAME = "omp-vscode-context"

let activeContext
let instanceId
let packageVersion
let server
let serverPort
let token
let serverEndpoint
let focusUnsubscribe
let focusSettingsWatcher
let focusSettingsRefreshTimer

export default function ompVscodeContextExtension(pi) {
  pi.setLabel("VS Code Context Bridge")

  pi.registerFlag("claim-ide-context-on-focus", {
    description: "On Linux, claim IDE context when this terminal gains focus",
    type: "boolean",
    default: false,
  })

  pi.registerCommand("ide", {
    description: "Route VS Code editor context to this OMP terminal",
    handler: async (args, ctx) => {
      activeContext = ctx
      await ensureServer(pi, ctx)
      if (args[0] === "status") {
        ctx.ui.notify(`VS Code Context Bridge ${packageVersion} is listening on ${serverEndpoint}.`, "info")
        return
      }
      if (await claimActiveBridge({ force: true })) {
        ctx.ui.notify(`VS Code context will target this terminal via ${serverEndpoint}.`, "info")
      }
    },
  })

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx
    await ensureServer(pi, ctx)
    await claimActiveBridge()
    await refreshFocusClaiming(pi)
    watchFocusSettings(pi)
  })

  pi.on("session_switch", async (_event, ctx) => {
    activeContext = ctx
    await ensureServer(pi, ctx)
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

  try {
    focusSettingsWatcher = watch(dirname(PLUGINS_LOCK_FILE), { persistent: false }, (_event, filename) => {
      if (filename === null || basename(filename.toString()) !== basename(PLUGINS_LOCK_FILE)) {
        return
      }
      clearTimeout(focusSettingsRefreshTimer)
      focusSettingsRefreshTimer = setTimeout(() => {
        void refreshFocusClaiming(pi)
      }, 25)
    })
  } catch {}
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
    await deliverContext(body)
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

async function deliverContext(body) {
  if (await pasteToPromptEditor(body.prompt)) {
    return
  }

  throw new Error("No active OMP prompt editor available")
}

function withEditSeparator(prompt) {
  return prompt.endsWith(" ") ? prompt : `${prompt} `
}

async function pasteToPromptEditor(prompt) {
  if (!activeContext?.hasUI) {
    return false
  }

  const ui = activeContext.ui

  if (typeof ui?.pasteToEditor === "function") {
    await ui.pasteToEditor(prompt)
    if (!prompt.endsWith(" ")) {
      await ui.pasteToEditor(" ")
    }
    return true
  }

  if (typeof ui?.setEditorText !== "function") {
    return false
  }

  const beforePasteText = typeof ui.getEditorText === "function" ? await ui.getEditorText() : ""
  await ui.setEditorText(`${beforePasteText}${withEditSeparator(prompt)}`)
  return true
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
  const temporaryStateFile = `${STATE_FILE}.${instanceId}.${randomBytes(8).toString("hex")}.tmp`
  try {
    await writeFile(temporaryStateFile, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    })
    await rename(temporaryStateFile, STATE_FILE)
  } finally {
    await rm(temporaryStateFile, {
      force: true,
    })
  }
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
  const closingStateFile = `${STATE_FILE}.${closingInstanceId}.${randomBytes(8).toString("hex")}.closing`
  try {
    if ((await readStateFile())?.instanceId !== closingInstanceId) {
      return
    }
    await rename(STATE_FILE, closingStateFile)
  } catch {
    return
  }

  let removeClosingStateFile = true
  try {
    const closingState = JSON.parse(await readFile(closingStateFile, "utf8"))
    if (closingState.instanceId !== closingInstanceId) {
      try {
        await link(closingStateFile, STATE_FILE)
      } catch (error) {
        if (error?.code !== "EEXIST") {
          removeClosingStateFile = false
        }
      }
    }
  } catch {
    return
  } finally {
    if (removeClosingStateFile) {
      await rm(closingStateFile, {
        force: true,
      })
    }
  }
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
