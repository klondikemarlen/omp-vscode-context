import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import * as vscode from "vscode"

import { formatContextPrompt, type ContentMode, type EditorContext } from "./prompt"

type Delivery = "paste" | "send" | "nextTurn"

interface BridgeState {
  readonly endpoint: string
  readonly token?: string
}

interface BridgeRequest {
  readonly delivery: Delivery
  readonly prompt: string
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:47687"
const STATE_FILE = path.join(os.homedir(), ".omp", "agent", "editor-context-bridge.json")
const REQUEST_TIMEOUT_MILLISECONDS = 2000

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    "ompContext.insertEditorContext",
    insertEditorContext,
  )

  context.subscriptions.push(disposable)
}

export function deactivate() {}

async function insertEditorContext() {
  const activeEditor = vscode.window.activeTextEditor
  if (activeEditor === undefined) {
    await vscode.window.showWarningMessage("Open a file before sending context to OMP.")
    return
  }

  const editorContext = getEditorContext(activeEditor)
  const prompt = formatContextPrompt(editorContext, getContentMode())
  const bridgeRequest = getBridgeRequest(prompt)
  const bridgeState = await getBridgeState()

  try {
    await postContext(bridgeState, bridgeRequest)
  } catch (error) {
    await vscode.env.clipboard.writeText(prompt)
    const message = error instanceof Error ? error.message : "Unknown bridge error"
    await vscode.window.showWarningMessage(
      `OMP bridge unavailable; copied context to clipboard. ${message}`,
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

function getBridgeRequest(prompt: string): BridgeRequest {
  const configuredDelivery = vscode.workspace
    .getConfiguration("ompContext")
    .get<string>("delivery", "paste")

  return {
    delivery: getDelivery(configuredDelivery),
    prompt,
  }
}

function getRelativePath(document: vscode.TextDocument) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
  if (workspaceFolder !== undefined) {
    return vscode.workspace.asRelativePath(document.uri, false)
  }

  if (document.uri.scheme === "file") {
    return document.uri.fsPath
  }

  return document.uri.toString()
}

function getContentMode(): ContentMode {
  const value = vscode.workspace
    .getConfiguration("ompContext")
    .get<string>("contentMode", "reference")

  if (value === "inline") {
    return value
  }

  return "reference"
}

function getDelivery(value: string): Delivery {
  if (value === "send" || value === "nextTurn") {
    return value
  }

  return "paste"
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

async function postContext(bridgeState: BridgeState, bridgeRequest: BridgeRequest) {
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
