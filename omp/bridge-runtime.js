import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, readFile, rename, rm, writeFile, link } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const HOST = "127.0.0.1"
const MAX_PORT_ATTEMPTS = 20
const MAX_BODY_BYTES = 2 * 1024 * 1024
const HEALTH_TIMEOUT_MILLISECONDS = 500

export function createBridgeRuntime({
  deliverPrompt,
  notify,
  packageFile,
  stateFile = join(homedir(), ".omp", "agent", "editor-context-bridge.json"),
  defaultPort = Number.parseInt(process.env.OMP_CONTEXT_BRIDGE_PORT ?? "47687", 10),
}) {
  let instanceId
  let packageVersion
  let server
  let port
  let token
  let endpoint

  return {
    async start() {
      if (server !== undefined) {
        return
      }

      instanceId = randomBytes(16).toString("hex")
      packageVersion = await readPackageVersion(packageFile)
      token = randomBytes(32).toString("hex")

      for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
        const candidatePort = defaultPort + offset
        const candidateServer = createServer((request, response) => {
          void handleRequest(request, response)
        })

        try {
          await listen(candidateServer, candidatePort)
          server = candidateServer
          port = candidatePort
          endpoint = `http://${HOST}:${port}`
          return
        } catch (error) {
          candidateServer.close()
          if (!isAddressInUse(error)) {
            throw error
          }
        }
      }

      notify("VS Code context bridge could not find an available local port.", "error")
    },

    async claim({ force = false } = {}) {
      if (endpoint === undefined || port === undefined) {
        return false
      }
      if (!force && await hasLiveBridgeOwner()) {
        return false
      }
      await writeStateFile()
      return true
    },

    async close() {
      if (server === undefined) {
        return
      }

      const closingServer = server
      const closingInstanceId = instanceId
      server = undefined
      endpoint = undefined
      port = undefined
      instanceId = undefined
      token = undefined

      await new Promise(resolve => closingServer.close(resolve))
      await removeStateFile(closingInstanceId)
    },

    get endpoint() {
      return endpoint
    },

    get version() {
      return packageVersion
    },
  }

  async function handleRequest(request, response) {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { ok: true, instanceId, endpoint })
      return
    }
    if (request.method !== "POST" || request.url !== "/context") {
      sendJson(response, 404, { error: "Not found" })
      return
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { error: "Unauthorized" })
      return
    }

    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid request body" })
      return
    }
    if (typeof body !== "object" || body === null || typeof body.prompt !== "string" || body.prompt.length === 0) {
      sendJson(response, 400, { error: "Expected a context request with a prompt string" })
      return
    }

    try {
      await deliverPrompt(body.prompt)
      sendJson(response, 200, { ok: true })
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Failed to deliver context" })
    }
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
      const state = JSON.parse(await readFile(stateFile, "utf8"))
      if (typeof state.endpoint === "string") {
        return state
      }
    } catch {}
    return undefined
  }

  async function writeStateFile() {
    const state = {
      endpoint,
      port,
      token,
      pid: process.pid,
      instanceId,
      version: packageVersion,
      updatedAt: new Date().toISOString(),
    }
    await mkdir(dirname(stateFile), { recursive: true })
    const temporaryStateFile = `${stateFile}.${instanceId}.${randomBytes(8).toString("hex")}.tmp`
    try {
      await writeFile(temporaryStateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      await rename(temporaryStateFile, stateFile)
    } finally {
      await rm(temporaryStateFile, { force: true })
    }
  }

  async function removeStateFile(closingInstanceId) {
    const closingStateFile = `${stateFile}.${closingInstanceId}.${randomBytes(8).toString("hex")}.closing`
    try {
      if ((await readStateFile())?.instanceId !== closingInstanceId) {
        return
      }
      await rename(stateFile, closingStateFile)
    } catch {
      return
    }

    let removeClosingStateFile = true
    try {
      const closingState = JSON.parse(await readFile(closingStateFile, "utf8"))
      if (closingState.instanceId !== closingInstanceId) {
        try {
          await link(closingStateFile, stateFile)
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
        await rm(closingStateFile, { force: true })
      }
    }
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, HOST, () => {
      server.off("error", reject)
      resolve()
    })
  })
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on("data", chunk => {
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
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        reject(new Error("Request body is not valid JSON"))
      }
    })
    request.on("error", reject)
  })
}

async function isHealthyEndpoint(endpoint, expectedInstanceId) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MILLISECONDS)
  try {
    const response = await fetch(`${endpoint}/health`, { signal: controller.signal })
    if (!response.ok) {
      return false
    }
    return (await response.json())?.instanceId === expectedInstanceId
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function readPackageVersion(packageFile) {
  const packageJson = JSON.parse(await readFile(packageFile, "utf8"))
  return typeof packageJson.version === "string" ? packageJson.version : "unknown"
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json" })
  response.end(JSON.stringify(body))
}

function isAddressInUse(error) {
  return typeof error === "object" && error !== null && error.code === "EADDRINUSE"
}
