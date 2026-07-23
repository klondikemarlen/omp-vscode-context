import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import vm from "node:vm"

const contextSource = await fs.readFile(new URL("../firefox/context.js", import.meta.url), "utf8")
const context = { URL }
vm.runInNewContext(contextSource, context)
const { createEnvelope, formatPrompt, isSupportedGithubUrl } = context.ompSendContext

test("Firefox client recognizes GitHub pull-request pages", () => {
  assert.equal(isSupportedGithubUrl("https://github.com/org/repo/pull/42/files"), true)
  assert.equal(isSupportedGithubUrl("https://github.com/org/repo/issues/42"), false)
  assert.equal(isSupportedGithubUrl("https://evil.example/github.com/org/repo/pull/42"), false)
})

test("Firefox client creates a protocol v1 envelope with permalink metadata", () => {
  const envelope = createEnvelope({
    selectionText: "return db.transaction(async () => {})",
    linkUrl: "https://github.com/org/repo/pull/42/files#diff-abcR53",
    pageUrl: "https://github.com/org/repo/pull/42/files",
    title: "Add transactions",
  })

  assert.deepEqual(JSON.parse(JSON.stringify(envelope)), {
    version: 1,
    source: "firefox",
    prompt: "# OMP Agent Handoff\n\n## GitHub\n\n- Title: Add transactions\n\n- Location: https://github.com/org/repo/pull/42/files#diff-abcR53\n\n## Selected text\n\n```\nreturn db.transaction(async () => {})\n```",
    metadata: {
      url: "https://github.com/org/repo/pull/42/files#diff-abcR53",
      title: "Add transactions",
    },
  })
})

test("Firefox client lengthens fences and falls back to the page URL", () => {
  const selection = "```js\nconst value = 1\n```"
  assert.equal(formatPrompt({
    selectionText: selection,
    url: "https://github.com/org/repo/pull/42",
  }), "# OMP Agent Handoff\n\n## GitHub\n\n- Location: https://github.com/org/repo/pull/42\n\n## Selected text\n\n````\n```js\nconst value = 1\n```\n````")

  const envelope = createEnvelope({
    selectionText: "const value = 1",
    linkUrl: "not-a-url",
    pageUrl: "https://github.com/org/repo/pull/42",
  })
  assert.equal(envelope.metadata.url, "https://github.com/org/repo/pull/42")
})

test("Firefox client rejects empty selection and unsupported pages", () => {
  assert.throws(() => createEnvelope({
    selectionText: "",
    pageUrl: "https://github.com/org/repo/pull/42",
  }), /Select GitHub code/)
  assert.throws(() => createEnvelope({
    selectionText: "const value = 1",
    pageUrl: "https://github.com/org/repo/issues/42",
  }), /pull-request pages/)
})
