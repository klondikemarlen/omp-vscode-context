import test from "node:test"
import assert from "node:assert/strict"

import { buildReference, formatAgentHandoffPacket, formatContextPrompt, resolveInsertMode, type EditorContext } from "../src/prompt"

function editorContext(overrides: Partial<EditorContext>): EditorContext {
  return {
    relativePath: "src/example.ts",
    startLine: 7,
    endLine: 9,
    startCharacter: 17,
    endCharacter: 20,
    selectedText: "const value = 1\nreturn value",
    languageId: "typescript",
    ...overrides,
  }
}

test("buildReference formats character-precise references", () => {
  const reference = buildReference(editorContext({}))

  assert.equal(reference, "@src/example.ts#L7C17-L9C20")
})

test("buildReference collapses a single cursor position", () => {
  const reference = buildReference(editorContext({
    startLine: 7,
    endLine: 7,
    startCharacter: 17,
    endCharacter: 17,
  }))

  assert.equal(reference, "@src/example.ts#L7C17")
})


test("formatContextPrompt includes selected code in inline mode", () => {
  const prompt = formatContextPrompt(editorContext({}), "inline")

  assert.equal(prompt, "@src/example.ts#L7C17-L9C20 \n\n```typescript\nconst value = 1\nreturn value\n```")
})

test("formatContextPrompt lengthens fence when selection contains backticks", () => {
  const prompt = formatContextPrompt(editorContext({
    relativePath: "README.md",
    startLine: 1,
    endLine: 3,
    startCharacter: 1,
    endCharacter: 3,
    selectedText: "```ts\nconst value = 1\n```",
    languageId: "markdown",
  }), "inline")

  assert.equal(prompt, "@README.md#L1C1-L3C3 \n\n````markdown\n```ts\nconst value = 1\n```\n````")
})

test("formatContextPrompt emits a trailing space for cursor references", () => {
  const prompt = formatContextPrompt(editorContext({
    startLine: 3,
    endLine: 3,
    startCharacter: 8,
    endCharacter: 8,
    selectedText: "",
  }))

  assert.equal(prompt, "@src/example.ts#L3C8 ")
})

test("resolveInsertMode defaults to agent handoff unless editor context is selected", () => {
  assert.equal(resolveInsertMode(undefined), "agentHandoff")
  assert.equal(resolveInsertMode("bogus"), "agentHandoff")
  assert.equal(resolveInsertMode("editorContext"), "editorContext")
  assert.equal(resolveInsertMode("agentHandoff"), "agentHandoff")
})

test("formatAgentHandoffPacket omits empty optional sections", () => {
  const prompt = formatAgentHandoffPacket({
    current: editorContext({
      selectedText: "",
    }),
    contentMode: "reference",
    diagnostics: [],
    maxBytes: 20_000,
  })

  assert.match(prompt, /^# OMP Agent Handoff\n\n## Active editor\n\n@src\/example\.ts#L7C17-L9C20 \n\n$/)
  assert.doesNotMatch(prompt, /## (Goal \/ constraints \/ verify with|Instructions|Other visible editors|Diagnostics)/)
})

test("formatAgentHandoffPacket includes handoff context and omission notes", () => {
  const prompt = formatAgentHandoffPacket({
    current: editorContext({
      relativePath: "src/current.ts",
      startLine: 3,
      endLine: 5,
      startCharacter: 1,
      endCharacter: 12,
      selectedText: "const current = true",
      languageId: "typescript",
    }),
    contentMode: "inline",
    workspaceRoot: "/work/omp-vscode-context",
    diagnostics: [{
      relativePath: "src/current.ts",
      startLine: 4,
      endLine: 4,
      startCharacter: 7,
      endCharacter: 14,
      severity: "Error",
      source: "ts",
      message: "Type 'string' is not assignable to type 'number'.",
    }],
    omittedDiagnostics: 3,
    maxBytes: 20_000,
  })

  assert.match(prompt, /^# OMP Agent Handoff/)
  assert.doesNotMatch(prompt, /## Instructions/)
  assert.match(prompt, /@src\/current\.ts#L3C1-L5C12/)
  assert.match(prompt, /```typescript\nconst current = true\n```/)
  assert.match(prompt, /- Root: `\/work\/omp-vscode-context`/)
  assert.match(prompt, /- Error ts: @src\/current\.ts#L4C7-L4C14 Type 'string' is not assignable to type 'number'\./)
  assert.match(prompt, /3 more omitted by ompContext\.handoffMaxDiagnostics/)
  assert.equal(prompt.endsWith("\n\n"), true)
})

test("formatAgentHandoffPacket respects byte cap without splitting UTF-8", () => {
  const prompt = formatAgentHandoffPacket({
    current: editorContext({
      selectedText: "🙂".repeat(200),
      languageId: "typescript",
    }),
    contentMode: "inline",
    workspaceRoot: "/work/omp-vscode-context",
    diagnostics: [],
    maxBytes: 300,
  })

  assert.ok(Buffer.byteLength(prompt, "utf8") <= 300)
  assert.ok(prompt.endsWith("\n\n… truncated by ompContext.handoffMaxBytes\n\n"))
  assert.equal(prompt.includes("\uFFFD"), false)
})

test("formatAgentHandoffPacket redacts secret-looking diagnostic values", () => {
  const prompt = formatAgentHandoffPacket({
    current: editorContext({
      selectedText: "",
    }),
    contentMode: "reference",
    workspaceRoot: "/work/omp-vscode-context",
    diagnostics: [{
      relativePath: "src/secrets.ts",
      startLine: 9,
      endLine: 9,
      startCharacter: 3,
      endCharacter: 18,
      severity: "Warning",
      source: "eslint",
      message: "Do not commit password: hunter2 token=abc123 api_key=secret-key Authorization: Bearer sk-live-auth-token",
    }],
    maxBytes: 20_000,
  })

  assert.match(prompt, /password=\[redacted\]/)
  assert.match(prompt, /token=\[redacted\]/)
  assert.match(prompt, /api_key=\[redacted\]/)
  assert.match(prompt, /authorization=\[redacted\]/i)
  assert.doesNotMatch(prompt, /hunter2|abc123|secret-key|Bearer|sk-live-auth-token/)
})
