#!/usr/bin/env node
// Linux Firefox native messaging host. The protocol code is portable; registration is Linux-only for now.
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_STATE_FILE = join(homedir(), ".omp", "agent", "editor-context-bridge.json")
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024

export async function deliverEnvelope(envelope, {
  stateFile = process.env.OMP_CONTEXT_STATE_FILE ?? DEFAULT_STATE_FILE,
  fetchImpl = fetch,
} = {}) {
  assertEnvelope(envelope)
  const state = JSON.parse(await readFile(stateFile, "utf8"))
  const endpoint = new URL(state.endpoint)
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.port.length === 0 || typeof state.token !== "string" || state.token.length === 0) {
    throw new Error("Invalid OMP bridge state")
  }

  const response = await fetchImpl(`${endpoint.origin}/context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.token}`,
    },
    body: JSON.stringify(envelope),
  })
  if (!response.ok) {
    throw new Error(`OMP bridge returned ${response.status}`)
  }
}

export function assertEnvelope(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a context envelope")
  }
  if (value.version !== 1 || (value.source !== "vscode" && value.source !== "firefox") || typeof value.prompt !== "string" || value.prompt.length === 0) {
    throw new Error("Expected a version 1 context envelope")
  }
  if (value.metadata !== undefined && (typeof value.metadata !== "object" || value.metadata === null || Array.isArray(value.metadata))) {
    throw new Error("Expected object metadata")
  }
  if (value.metadata?.url !== undefined && typeof value.metadata.url !== "string") {
    throw new Error("Expected string metadata URL")
  }
  if (value.metadata?.title !== undefined && typeof value.metadata.title !== "string") {
    throw new Error("Expected string metadata title")
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("Context envelope is too large")
  }
}

export function encodeMessage(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length, 0)
  return Buffer.concat([header, payload])
}

async function main() {
  let pending = Buffer.alloc(0)
  let queue = Promise.resolve()

  process.stdin.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 4) {
      const length = pending.readUInt32LE(0)
      if (length > MAX_MESSAGE_BYTES) {
        pending = Buffer.alloc(0)
        queue = queue.then(() => sendResponse({ ok: false, error: "Message is too large" }))
        return
      }
      if (pending.length < length + 4) {
        return
      }
      const payload = pending.subarray(4, length + 4).toString("utf8")
      pending = pending.subarray(length + 4)
      queue = queue.then(() => handleMessage(payload))
    }
  })

  await new Promise((resolve) => process.stdin.on("end", resolve))
  await queue
}

async function handleMessage(payload) {
  try {
    await deliverEnvelope(JSON.parse(payload))
    await sendResponse({ ok: true })
  } catch (error) {
    await sendResponse({ ok: false, error: error instanceof Error ? error.message : "Failed to deliver context" })
  }
}

function sendResponse(value) {
  return new Promise((resolve, reject) => {
    const message = encodeMessage(value)
    process.stdout.write(message, (error) => error === undefined || error === null ? resolve() : reject(error))
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
