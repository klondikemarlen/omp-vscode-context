import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import * as vscode from "vscode"

import { formatAgentHandoffPacket, formatContextPrompt, resolveContentMode, type EditorContext, type EditorReference, type HandoffDiagnostic } from "./prompt"


interface BridgeState {
  readonly endpoint: string
  readonly token?: string
}


const DEFAULT_ENDPOINT = "http://127.0.0.1:47687"
const STATE_FILE = path.join(os.homedir(), ".omp", "agent", "editor-context-bridge.json")
const REQUEST_TIMEOUT_MILLISECONDS = 2000
const DEFAULT_HANDOFF_MAX_BYTES = 20_000
const DEFAULT_HANDOFF_MAX_DIAGNOSTICS = 20
const DEFAULT_HANDOFF_MAX_VISIBLE_EDITORS = 10
const DEFAULT_HANDOFF_PREFACE = "Goal:\n\nConstraints:\n\nVerify with:"

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
}

export function deactivate() {}

async function insertEditorContext() {
  const activeEditor = vscode.window.activeTextEditor
  if (activeEditor === undefined) {
    await vscode.window.showWarningMessage("Open a file before sending context to OMP.")
    return
  }

  const prompt = formatContextPrompt(getEditorContext(activeEditor), getContentMode())
  await sendPrompt(prompt, "context")
}

async function insertAgentHandoffContext() {
  const activeEditor = vscode.window.activeTextEditor
  if (activeEditor === undefined) {
    await vscode.window.showWarningMessage("Open a file before sending an agent handoff to OMP.")
    return
  }

  const settings = getHandoffSettings()
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)
    ?? vscode.workspace.workspaceFolders?.[0]
  const visibleEditorReferences = vscode.window.visibleTextEditors.map(getEditorReference)
  const diagnostics = getHandoffDiagnostics()
  const prompt = formatAgentHandoffPacket({
    current: getEditorContext(activeEditor),
    contentMode: getContentMode(),
    workspaceRoot: workspaceFolder?.uri.fsPath,
    visibleEditors: visibleEditorReferences.slice(0, settings.maxVisibleEditors),
    omittedVisibleEditors: Math.max(0, visibleEditorReferences.length - settings.maxVisibleEditors),
    diagnostics: diagnostics.slice(0, settings.maxDiagnostics),
    omittedDiagnostics: Math.max(0, diagnostics.length - settings.maxDiagnostics),
    preface: settings.preface,
    maxBytes: settings.maxBytes,
  })

  await sendPrompt(prompt, "agent handoff")
}

async function sendPrompt(prompt: string, label: string) {
  try {
    await postContext(await getBridgeState(), { prompt })
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

function getEditorReference(editor: vscode.TextEditor): EditorReference {
  const context = getEditorContext(editor)
  return {
    relativePath: context.relativePath,
    startLine: context.startLine,
    endLine: context.endLine,
    startCharacter: context.startCharacter,
    endCharacter: context.endCharacter,
  }
}

function getHandoffSettings() {
  const configuration = vscode.workspace.getConfiguration("ompContext")

  return {
    preface: configuration.get<string>("handoffPreface", DEFAULT_HANDOFF_PREFACE),
    maxBytes: Math.max(1_000, configuration.get<number>("handoffMaxBytes", DEFAULT_HANDOFF_MAX_BYTES)),
    maxDiagnostics: Math.max(0, Math.floor(configuration.get<number>("handoffMaxDiagnostics", DEFAULT_HANDOFF_MAX_DIAGNOSTICS))),
    maxVisibleEditors: Math.max(0, Math.floor(configuration.get<number>("handoffMaxVisibleEditors", DEFAULT_HANDOFF_MAX_VISIBLE_EDITORS))),
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

async function postContext(bridgeState: BridgeState, bridgeRequest: { prompt: string }) {
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
