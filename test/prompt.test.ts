import test from "node:test"
import assert from "node:assert/strict"

import { buildReference, formatContextPrompt, resolveContentMode, type EditorContext } from "../src/prompt"

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

test("formatContextPrompt defaults to inline selected code", () => {
  const prompt = formatContextPrompt(editorContext({}))

  assert.equal(prompt, "@src/example.ts#L7C17-L9C20 \n\n```typescript\nconst value = 1\nreturn value\n```")
})

test("resolveContentMode keeps reference and defaults invalid values to inline", () => {
  assert.equal(resolveContentMode("reference"), "reference")
  assert.equal(resolveContentMode("inline"), "inline")
  assert.equal(resolveContentMode(undefined), "inline")
  assert.equal(resolveContentMode("bogus"), "inline")
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
