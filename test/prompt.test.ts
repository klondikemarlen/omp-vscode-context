import test from "node:test"
import assert from "node:assert/strict"

import { buildReference, formatAgentHandoffPacket, formatContextPrompt, type EditorContext } from "../src/prompt"

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
    visibleEditors: [
      {
        relativePath: "src/current.ts",
        startLine: 3,
        endLine: 5,
        startCharacter: 1,
        endCharacter: 12,
      },
      {
        relativePath: "test/prompt.test.ts",
        startLine: 42,
        endLine: 42,
        startCharacter: 1,
        endCharacter: 1,
      },
    ],
    omittedVisibleEditors: 2,
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
    preface: "Goal: fix the failing handoff\nVerify with: targeted tests",
    maxBytes: 20_000,
  })

  assert.match(prompt, /^# OMP Agent Handoff/)
  assert.match(prompt, /## Goal \/ constraints \/ verify with\n\nGoal: fix the failing handoff\nVerify with: targeted tests/)
  assert.match(prompt, /@src\/current\.ts#L3C1-L5C12/)
  assert.match(prompt, /```typescript\nconst current = true\n```/)
  assert.match(prompt, /- Root: `\/work\/omp-vscode-context`/)
  assert.match(prompt, /- @test\/prompt\.test\.ts#L42C1/)
  assert.match(prompt, /2 more omitted by ompContext\.handoffMaxVisibleEditors/)
  assert.match(prompt, /- Error ts: @src\/current\.ts#L4C7-L4C14 Type 'string' is not assignable to type 'number'\./)
  assert.match(prompt, /3 more omitted by ompContext\.handoffMaxDiagnostics/)
})

test("formatAgentHandoffPacket respects byte cap without splitting UTF-8", () => {
  const prompt = formatAgentHandoffPacket({
    current: editorContext({
      selectedText: "🙂".repeat(200),
      languageId: "typescript",
    }),
    contentMode: "inline",
    workspaceRoot: "/work/omp-vscode-context",
    visibleEditors: [],
    diagnostics: [],
    preface: "Goal: keep the packet under the configured cap",
    maxBytes: 300,
  })

  assert.ok(Buffer.byteLength(prompt, "utf8") <= 300)
  assert.ok(prompt.endsWith("\n\n… truncated by ompContext.handoffMaxBytes"))
  assert.equal(prompt.includes("\uFFFD"), false)
})

test("formatAgentHandoffPacket redacts secret-looking diagnostic values", () => {
  const prompt = formatAgentHandoffPacket({
    current: editorContext({
      selectedText: "",
    }),
    contentMode: "reference",
    workspaceRoot: "/work/omp-vscode-context",
    visibleEditors: [],
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
    preface: "Check diagnostics",
    maxBytes: 20_000,
  })

  assert.match(prompt, /password=\[redacted\]/)
  assert.match(prompt, /token=\[redacted\]/)
  assert.match(prompt, /api_key=\[redacted\]/)
  assert.match(prompt, /authorization=\[redacted\]/i)
  assert.doesNotMatch(prompt, /hunter2|abc123|secret-key|Bearer|sk-live-auth-token/)
})
