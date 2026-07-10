export interface EditorContext {
  readonly relativePath: string
  readonly startLine: number
  readonly endLine: number
  readonly startCharacter: number
  readonly endCharacter: number
  readonly selectedText: string
  readonly languageId: string
}

export interface EditorReference {
  readonly relativePath: string
  readonly startLine: number
  readonly endLine: number
  readonly startCharacter: number
  readonly endCharacter: number
}

export interface HandoffDiagnostic extends EditorReference {
  readonly severity: string
  readonly message: string
  readonly source?: string
}

export interface AgentHandoffPacket {
  readonly current: EditorContext
  readonly contentMode: ContentMode
  readonly workspaceRoot?: string
  readonly diagnostics: readonly HandoffDiagnostic[]
  readonly omittedDiagnostics?: number
  readonly maxBytes: number
}

export type ContentMode = "reference" | "inline"

export const DEFAULT_CONTENT_MODE: ContentMode = "inline"
export type InsertMode = "editorContext" | "agentHandoff"

export const DEFAULT_INSERT_MODE: InsertMode = "agentHandoff"

export function resolveInsertMode(value: string | undefined): InsertMode {
  return value === "editorContext" || value === "agentHandoff" ? value : DEFAULT_INSERT_MODE
}


export function resolveContentMode(value: string | undefined): ContentMode {
  return value === "reference" ? "reference" : DEFAULT_CONTENT_MODE
}

const DEFAULT_CODE_FENCE = "```"

export function buildReference(context: EditorReference) {
  const startReference = `L${context.startLine}C${context.startCharacter}`
  const endReference = `L${context.endLine}C${context.endCharacter}`
  const rangeReference = startReference === endReference
    ? startReference
    : `${startReference}-${endReference}`

  return `@${context.relativePath}#${rangeReference}`
}

export function formatContextPrompt(context: EditorContext, contentMode: ContentMode = DEFAULT_CONTENT_MODE) {
  const reference = buildReference(context)

  if (contentMode === "reference" || context.selectedText.length === 0) {
    return `${reference} `
  }

  const fence = getCodeFence(context.selectedText)
  const language = normalizeLanguageId(context.languageId)

  return `${reference} \n\n${fence}${language}\n${context.selectedText}\n${fence}`
}

export function formatAgentHandoffPacket(packet: AgentHandoffPacket) {
  const sections = ["# OMP Agent Handoff"]

  sections.push("## Active editor", formatContextPrompt(packet.current, packet.contentMode))

  if (packet.workspaceRoot !== undefined) {
    sections.push("## Workspace", `- Root: \`${packet.workspaceRoot}\``)
  }
  const diagnostics = formatDiagnostics(packet.diagnostics, packet.omittedDiagnostics ?? 0)
  if (diagnostics.length > 0) {
    sections.push("## Diagnostics", diagnostics)
  }

  return endWithBlankLine(sections.join("\n\n"), packet.maxBytes)
}

function formatDiagnostics(diagnostics: readonly HandoffDiagnostic[], omittedCount = 0) {
  const lines = diagnostics.map((diagnostic) => {
    const source = diagnostic.source === undefined ? "" : ` ${diagnostic.source}:`
    return `- ${diagnostic.severity}${source} ${buildReference(diagnostic)} ${redactSecretishText(diagnostic.message)}`
  })
  if (omittedCount > 0) {
    lines.push(`- … ${omittedCount} more omitted by ompContext.handoffMaxDiagnostics`)
  }

  return lines.join("\n")
}
function redactSecretishText(text: string) {
  return text
    .replace(/\bauthorization\b\s*[:=]\s*(?:bearer|basic)\s+\S+/gi, "authorization=[redacted]")
    .replace(/\b(token|secret|password|api[_-]?key|authorization)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
}

function endWithBlankLine(text: string, maxBytes: number) {
  const terminator = "\n\n"
  return `${capBytes(text, Math.max(0, maxBytes - Buffer.byteLength(terminator)))}${terminator}`
}

function capBytes(text: string, maxBytes: number) {
  const suffix = "\n\n… truncated by ompContext.handoffMaxBytes"
  if (maxBytes <= Buffer.byteLength(suffix)) {
    return suffix.slice(0, maxBytes)
  }

  if (Buffer.byteLength(text) <= maxBytes) {
    return text
  }

  return Buffer
    .from(text)
    .subarray(0, maxBytes - Buffer.byteLength(suffix))
    .toString("utf8")
    .replace(/\uFFFD$/, "")
    + suffix
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
