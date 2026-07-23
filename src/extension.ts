import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import * as vscode from "vscode"

import { formatAgentHandoffPacket, formatContextPrompt, resolveContentMode, resolveInsertMode, type ContextEnvelope, type EditorContext, type HandoffDiagnostic } from "./prompt"


interface BridgeState {
  readonly endpoint: string
  readonly token?: string
}


const DEFAULT_ENDPOINT = "http://127.0.0.1:47687"
const STATE_FILE = path.join(os.homedir(), ".omp", "agent", "editor-context-bridge.json")
const REQUEST_TIMEOUT_MILLISECONDS = 2000
const DEFAULT_HANDOFF_MAX_BYTES = 20_000
const DEFAULT_HANDOFF_MAX_DIAGNOSTICS = 20
const LEGACY_MIGRATION_NOTICE_KEY = "ompContext.legacyMigrationNoticeShown"
const REPLACEMENT_EXTENSION_URL = "https://marketplace.visualstudio.com/items?itemName=klondikemarlen.omp-send-context"


export function activate(context: vscode.ExtensionContext) {
  const insertDisposable = vscode.commands.registerCommand(
    "ompContext.insertEditorContext",
    insertEditorContext,
  )
  const handoffDisposable = vscode.commands.registerCommand(
    "ompContext.insertAgentHandoff",
    insertAgentHandoffContext,
  )

  context.subscriptions.push(insertDisposable, handoffDisposable)
  void showMigrationNotice(context)
}

async function showMigrationNotice(context: vscode.ExtensionContext) {
  if (context.globalState.get<boolean>(LEGACY_MIGRATION_NOTICE_KEY) === true) {
    return
  }

  const action = await vscode.window.showWarningMessage(
    "OMP VS Code Context is deprecated. Install Oh My Pi Send Context before 2026-10-21.",
    "Install replacement",
  )
  await context.globalState.update(LEGACY_MIGRATION_NOTICE_KEY, true)
  if (action === "Install replacement") {
    await vscode.env.openExternal(vscode.Uri.parse(REPLACEMENT_EXTENSION_URL))
  }
}

export function deactivate() {}

async function insertEditorContext() {
  const activeEditor = vscode.window.activeTextEditor
  if (activeEditor === undefined) {
    await vscode.window.showWarningMessage("Open a file before sending context to OMP.")
    return
  }

  const prompt = getInsertMode() === "agentHandoff"
    ? buildAgentHandoffPrompt(activeEditor)
    : formatContextPrompt(getEditorContext(activeEditor), getContentMode())
  await sendPrompt(prompt, "context")
}

async function insertAgentHandoffContext() {
  const activeEditor = vscode.window.activeTextEditor
  if (activeEditor === undefined) {
    await vscode.window.showWarningMessage("Open a file before sending an agent handoff to OMP.")
    return
  }

  await sendPrompt(buildAgentHandoffPrompt(activeEditor), "agent handoff")
}

function buildAgentHandoffPrompt(activeEditor: vscode.TextEditor) {
  const settings = getHandoffSettings()
  const current = getEditorContext(activeEditor)
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)
    ?? vscode.workspace.workspaceFolders?.[0]
  const diagnostics = getHandoffDiagnostics()

  return formatAgentHandoffPacket({
    current,
    contentMode: getContentMode(),
    workspaceRoot: workspaceFolder?.uri.fsPath,
    diagnostics: diagnostics.slice(0, settings.maxDiagnostics),
    omittedDiagnostics: Math.max(0, diagnostics.length - settings.maxDiagnostics),
    maxBytes: settings.maxBytes,
  })

}

async function sendPrompt(prompt: string, label: string) {
  const request: ContextEnvelope = {
    version: 1,
    source: "vscode",
    prompt,
  }

  try {
    await postContext(await getBridgeState(), request)
  } catch (error) {
    await vscode.env.clipboard.writeText(prompt)
    const message = error instanceof Error ? error.message : "Unknown bridge error"
    await vscode.window.showWarningMessage(
      `OMP bridge unavailable; copied ${label} to clipboard. ${message}`,
    )
  }
}

function getEditorContext(activeEditor: vscode.TextEditor): EditorContext {
  const document = activeEditor.document
  const selection = activeEditor.selection
  const relativePath = getRelativePath(document)

  if (selection.isEmpty) {
    const line = selection.active.line + 1

    return {
      relativePath,
      startLine: line,
      endLine: line,
      startCharacter: selection.active.character + 1,
      endCharacter: selection.active.character + 1,
      selectedText: "",
      languageId: document.languageId,
    }
  }

  const startLine = selection.start.line + 1
  let endLine = selection.end.line + 1
  let endCharacter = selection.end.character
  if (selection.end.character === 0 && selection.end.line > selection.start.line) {
    endLine = selection.end.line
    endCharacter = document.lineAt(endLine - 1).text.length
  }

  return {
    relativePath,
    startLine,
    endLine,
    startCharacter: selection.start.character + 1,
    endCharacter,
    selectedText: document.getText(selection),
    languageId: document.languageId,
  }
}


function getRelativePath(document: vscode.TextDocument) {
  return getRelativePathForUri(document.uri)
}

function getRelativePathForUri(uri: vscode.Uri) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)
  if (workspaceFolder !== undefined) {
    return vscode.workspace.asRelativePath(uri, false)
  }

  if (uri.scheme === "file") {
    return uri.fsPath
  }

  return uri.toString()
}

function getContentMode() {
  return resolveContentMode(vscode.workspace
    .getConfiguration("ompContext")
    .get<string>("contentMode"))
}

function getInsertMode() {
  return resolveInsertMode(vscode.workspace
    .getConfiguration("ompContext")
    .get<string>("insertMode"))
}


function getHandoffSettings() {
  const configuration = vscode.workspace.getConfiguration("ompContext")

  return {
    maxBytes: Math.max(1_000, configuration.get<number>("handoffMaxBytes", DEFAULT_HANDOFF_MAX_BYTES)),
    maxDiagnostics: Math.max(0, Math.floor(configuration.get<number>("handoffMaxDiagnostics", DEFAULT_HANDOFF_MAX_DIAGNOSTICS))),
  }
}

function getHandoffDiagnostics(): HandoffDiagnostic[] {
  const severities = ["Error", "Warning", "Information", "Hint"]

  return vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) => diagnostics.map((diagnostic) => ({
    relativePath: getRelativePathForUri(uri),
    startLine: diagnostic.range.start.line + 1,
    endLine: diagnostic.range.end.line + 1,
    startCharacter: diagnostic.range.start.character + 1,
    endCharacter: diagnostic.range.end.character + 1,
    severity: severities[diagnostic.severity] ?? "Diagnostic",
    message: diagnostic.message,
    source: diagnostic.source,
  })))
}


async function getBridgeState(): Promise<BridgeState> {
  const configuredEndpoint = vscode.workspace
    .getConfiguration("ompContext")
    .get<string>("endpoint", "")
    .trim()

  if (configuredEndpoint.length > 0) {
    return { endpoint: configuredEndpoint }
  }

  try {
    const stateContent = await fs.readFile(STATE_FILE, "utf8")
    const state = JSON.parse(stateContent) as unknown

    if (isBridgeStateFile(state)) {
      return {
        endpoint: state.endpoint,
        token: state.token,
      }
    }
  } catch {
    return { endpoint: DEFAULT_ENDPOINT }
  }

  return { endpoint: DEFAULT_ENDPOINT }
}

function isBridgeStateFile(value: unknown): value is BridgeState {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const candidate = value as { endpoint?: unknown; token?: unknown }
  const tokenIsValid = candidate.token === undefined || typeof candidate.token === "string"

  return typeof candidate.endpoint === "string" && tokenIsValid
}

async function postContext(bridgeState: BridgeState, bridgeRequest: ContextEnvelope) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MILLISECONDS)

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }

    if (bridgeState.token !== undefined) {
      headers.Authorization = `Bearer ${bridgeState.token}`
    }

    const response = await fetch(`${bridgeState.endpoint}/context`, {
      method: "POST",
      headers,
      body: JSON.stringify(bridgeRequest),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`OMP bridge returned ${response.status}: ${text}`)
    }
  } finally {
    clearTimeout(timeout)
  }
}
