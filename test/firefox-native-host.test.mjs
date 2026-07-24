import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createServer } from "node:http"

import { assertEnvelope, deliverEnvelope, encodeMessage } from "../firefox/native-host/omp-send-context-host.mjs"

async function availableServer(handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  return server
}

function serverPort(server) {
  return server.address().port
}

test("native host delivers protocol v1 envelopes with the bridge token", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-send-context-host-"))
  const stateFile = path.join(directory, "editor-context-bridge.json")
  let received
  const server = await availableServer(async (request, response) => {
    received = {
      authorization: request.headers.authorization,
      body: JSON.parse(await readRequest(request)),
    }
    response.writeHead(200)
    response.end(JSON.stringify({ ok: true }))
  })

  try {
    await fs.writeFile(stateFile, JSON.stringify({
      endpoint: `http://127.0.0.1:${serverPort(server)}`,
      token: "test-token",
    }))

    const child = spawn(process.execPath, ["firefox/native-host/omp-send-context-host.mjs"], {
      env: { ...process.env, OMP_CONTEXT_STATE_FILE: stateFile },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const output = new Promise((resolve, reject) => {
      const chunks = []
      child.stdout.on("data", chunk => chunks.push(chunk))
      child.on("error", reject)
      child.on("close", () => {
        const data = Buffer.concat(chunks)
        resolve(JSON.parse(data.subarray(4, 4 + data.readUInt32LE(0)).toString("utf8")))
      })
    })

    child.stdin.end(encodeMessage({
      version: 1,
      source: "firefox",
      prompt: "# OMP Agent Handoff\n\n## GitHub\n\nselected",
      metadata: { url: "https://github.com/org/repo/pull/1" },
    }))

    assert.deepEqual(await output, { ok: true })
    assert.deepEqual(received, {
      authorization: "Bearer test-token",
      body: {
        version: 1,
        source: "firefox",
        prompt: "# OMP Agent Handoff\n\n## GitHub\n\nselected",
        metadata: { url: "https://github.com/org/repo/pull/1" },
      },
    })
  } finally {
    await new Promise(resolve => server.close(resolve))
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("native host rejects invalid envelopes and non-loopback bridge state", async () => {
  assert.throws(() => assertEnvelope({ prompt: "legacy" }), /version 1/)
  assert.throws(() => assertEnvelope({ version: 1, source: "firefox", prompt: "x", metadata: [] }), /object metadata/)
  assert.throws(() => assertEnvelope({ version: 1, source: "firefox", prompt: "x".repeat(2_100_000) }), /too large/)

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-send-context-host-"))
  const stateFile = path.join(directory, "editor-context-bridge.json")
  try {
    await fs.writeFile(stateFile, JSON.stringify({ endpoint: "https://example.com", token: "secret" }))
    await assert.rejects(
      deliverEnvelope({ version: 1, source: "firefox", prompt: "context" }, { stateFile }),
      /Invalid OMP bridge state/,
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

function readRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on("data", chunk => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })
}
