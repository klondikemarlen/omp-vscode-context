export interface EditorContext {
  readonly relativePath: string
  readonly startLine: number
  readonly endLine: number
  readonly startCharacter: number
  readonly endCharacter: number
  readonly selectedText: string
  readonly languageId: string
}

export type ContentMode = "reference" | "inline"

const DEFAULT_CODE_FENCE = "```"

export function buildReference(
  context: Pick<EditorContext, "relativePath" | "startLine" | "endLine" | "startCharacter" | "endCharacter">,
) {
  const startReference = `L${context.startLine}C${context.startCharacter}`
  const endReference = `L${context.endLine}C${context.endCharacter}`
  const rangeReference = startReference === endReference
    ? startReference
    : `${startReference}-${endReference}`

  return `@${context.relativePath}#${rangeReference}`
}

export function formatContextPrompt(context: EditorContext, contentMode: ContentMode = "reference") {
  const reference = buildReference(context)

  if (contentMode === "reference" || context.selectedText.length === 0) {
    return `${reference} `
  }

  const fence = getCodeFence(context.selectedText)
  const language = normalizeLanguageId(context.languageId)

  return `${reference} \n\n${fence}${language}\n${context.selectedText}\n${fence}`
}

function normalizeLanguageId(languageId: string) {
  if (languageId.length === 0 || languageId === "plaintext") {
    return ""
  }

  return languageId.replace(/[^a-zA-Z0-9_+-]/g, "")
}

function getCodeFence(text: string) {
  if (!text.includes(DEFAULT_CODE_FENCE)) {
    return DEFAULT_CODE_FENCE
  }

  let fence = "````"
  while (text.includes(fence)) {
    fence += "`"
  }

  return fence
}
