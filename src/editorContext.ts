import { z } from "zod"

import { EditorContextSummarySchema } from "./protocol.ts"
import type { EditorContextSummary } from "./protocol.ts"

const mcpServerName = "prismic"
const editorContextTool = "get_editor_context"
const maxStringLength = 300

export interface ToolIdentity {
  server: string
  tool: string
}

interface ToolCallFields {
  title?: unknown
  rawInput?: unknown
}

// codex-acp titles MCP calls `mcp.<server>.<tool>` and puts { server, tool, arguments } in rawInput. Updates repeat
// neither when they are unchanged, so callers remember the identity from the start report.
export function identifyTool(fields: ToolCallFields): ToolIdentity | undefined {
  const input = fields.rawInput
  if (typeof input === "object" && input !== null) {
    const { server, tool } = input as { server?: unknown; tool?: unknown }
    if (typeof server === "string" && typeof tool === "string") return { server, tool }
  }
  const match = typeof fields.title === "string" ? /^mcp\.([^.]+)\.(.+)$/.exec(fields.title) : null
  if (match?.[1] !== undefined && match[2] !== undefined) return { server: match[1], tool: match[2] }
  return undefined
}

export function isEditorContextTool(identity: ToolIdentity | undefined): boolean {
  return identity?.server === mcpServerName && identity.tool === editorContextTool
}

// Key order must not depend on how a summary was built (live or parsed back from disk), or dedupe would misfire.
export function editorContextKey(summary: EditorContextSummary): string {
  return JSON.stringify(EditorContextSummarySchema.parse(summary))
}

const text = z
  .string()
  .transform((value) => value.slice(0, maxStringLength))
  .optional()
  .catch(undefined)
const flag = z.boolean().optional().catch(undefined)

// Unknown keys are stripped: the tool result also carries the draft `content`, `paths` and slice `item`, which must
// never reach the browser through this event.
const WindowDocumentSchema = z.object({
  id: z.string().min(1).transform((value) => value.slice(0, maxStringLength)),
  title: text,
  customTypeLabel: text,
  versionStatus: text,
  locale: text,
  readOnly: flag,
  hasUnsavedChanges: flag,
  focusedSlice: z.object({ name: text, variation: text }).optional().catch(undefined),
  focusedField: z.object({ label: text, type: text }).optional().catch(undefined),
})

const ContextWindowSchema = z.object({ document: WindowDocumentSchema.optional().catch(undefined) })

const EditorContextResultSchema = z.object({
  status: z.enum(["no_editor_window", "no_pin", "pinned_matches", "context_changed", "pinned_document_not_open"]),
  ambiguous: z.boolean().optional().catch(false),
  detected: ContextWindowSchema.optional().catch(undefined),
  pinned: z
    .object({
      documentId: z.string().min(1).transform((value) => value.slice(0, maxStringLength)),
      window: ContextWindowSchema.optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
})

type WindowDocument = z.infer<typeof WindowDocumentSchema>

export function summarizeEditorContext(result: unknown): EditorContextSummary | undefined {
  const parsed = EditorContextResultSchema.safeParse(result)
  if (!parsed.success) return undefined
  const { status, detected, pinned } = parsed.data

  const summary: EditorContextSummary = { status, ambiguous: parsed.data.ambiguous ?? false }
  const detectedDocument = detected?.document

  switch (status) {
    case "no_editor_window":
      return summary
    case "no_pin":
      return withWindowDocument(summary, detectedDocument)
    case "pinned_matches":
      return withWindowDocument(summary, pinned?.window?.document ?? detectedDocument)
    case "context_changed": {
      const next = withWindowDocument(summary, pinned?.window?.document ?? detectedDocument)
      if (detectedDocument !== undefined) next.detected = { id: detectedDocument.id, title: detectedDocument.title ?? "" }
      if (pinned !== undefined) next.pinned = { id: pinned.documentId }
      return next
    }
    case "pinned_document_not_open":
      if (pinned !== undefined) summary.pinned = { id: pinned.documentId }
      return summary
  }
}

function withWindowDocument(summary: EditorContextSummary, document: WindowDocument | undefined): EditorContextSummary {
  if (document === undefined) return summary
  const next: EditorContextSummary = {
    ...summary,
    document: {
      id: document.id,
      title: document.title ?? "",
      ...(document.customTypeLabel === undefined ? {} : { customTypeLabel: document.customTypeLabel }),
      ...(document.versionStatus === undefined ? {} : { versionStatus: document.versionStatus }),
      ...(document.locale === undefined ? {} : { locale: document.locale }),
      ...(document.readOnly === undefined ? {} : { readOnly: document.readOnly }),
      ...(document.hasUnsavedChanges === undefined ? {} : { hasUnsavedChanges: document.hasUnsavedChanges }),
    },
  }
  const slice = document.focusedSlice
  if (slice?.name !== undefined) {
    next.slice = { name: slice.name, ...(slice.variation === undefined ? {} : { variation: slice.variation }) }
  }
  const field = document.focusedField
  if (field?.label !== undefined) {
    next.field = { label: field.label, ...(field.type === undefined ? {} : { type: field.type }) }
  }
  return next
}

// The tool's single JSON text block, from the MCP result codex-acp reports in rawOutput ({ result, error }), or from
// ACP content blocks. structuredContent is used when the text isn't JSON.
export function extractToolResultJson(update: { rawOutput?: unknown; content?: unknown }): unknown {
  const output = update.rawOutput
  if (typeof output === "object" && output !== null) {
    const { result, error } = output as { result?: unknown; error?: unknown }
    if (error !== null && error !== undefined) return undefined
    if (typeof result === "object" && result !== null) {
      const { content, structuredContent } = result as { content?: unknown; structuredContent?: unknown }
      const fromText = parseFirstJsonText(textBlocks(content))
      if (fromText !== undefined) return fromText
      if (typeof structuredContent === "object" && structuredContent !== null) return structuredContent
    }
  }
  const blocks = Array.isArray(update.content)
    ? update.content.flatMap((entry: unknown) =>
        typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "content"
          ? textBlocks([(entry as { content?: unknown }).content])
          : [],
      )
    : []
  return parseFirstJsonText(blocks)
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((block: unknown) => {
    if (typeof block !== "object" || block === null) return []
    const { type, text: blockText } = block as { type?: unknown; text?: unknown }
    return type === "text" && typeof blockText === "string" ? [blockText] : []
  })
}

function parseFirstJsonText(texts: string[]): unknown {
  for (const candidate of texts) {
    try {
      return JSON.parse(candidate)
    } catch {
      continue
    }
  }
  return undefined
}
