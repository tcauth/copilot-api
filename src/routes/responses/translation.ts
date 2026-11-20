import { createHash, randomUUID } from "node:crypto"

import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ResponseContent,
  ResponseFunctionTool,
  ResponseInputItem,
  ResponseNamespaceTool,
  ResponseOutputItem,
  ResponseTool,
  ResponsesPayload,
  ResponsesResult,
  ResponsesStreamState,
  ResponseUsage,
} from "./types"

export class UnsupportedResponsesFeatureError extends Error {
  code = "unsupported_responses_feature"
}

export interface ResponsesToolNames {
  fromCopilot: Map<string, { name: string; namespace?: string }>
  toCopilot: Map<string, string>
}

export interface ResponsesTranslation {
  chatPayload: ChatCompletionsPayload
  toolNames: ResponsesToolNames
}

function unsupported(message: string): never {
  throw new UnsupportedResponsesFeatureError(message)
}

function contentToChat(
  content: string | Array<ResponseContent>,
): string | Array<ContentPart> {
  if (typeof content === "string") return content

  const parts: Array<ContentPart> = []
  for (const part of content) {
    if (part.type === "input_text" || part.type === "output_text") {
      if (typeof part.text !== "string") {
        unsupported(`${part.type}.text is required`)
      }
      parts.push({ type: "text", text: part.text })
    } else if (part.type === "input_image") {
      if (!part.image_url) {
        unsupported("input_image.file_id is not supported; use image_url")
      }
      parts.push({
        type: "image_url",
        image_url: {
          url: part.image_url,
          detail:
            part.detail === "low" || part.detail === "high" ?
              part.detail
            : "auto",
        },
      })
    } else {
      unsupported(`input content type '${part.type}' is not supported`)
    }
  }
  return parts
}

function outputToText(output: string | Array<ResponseContent>): string {
  if (typeof output === "string") return output
  const text: Array<string> = []
  for (const part of output) {
    if (part.type === "input_text" || part.type === "output_text") {
      if (typeof part.text !== "string") {
        unsupported(`${part.type}.text is required`)
      }
      text.push(part.text)
    } else {
      unsupported(
        `function output content type '${part.type}' is not supported`,
      )
    }
  }
  return text.join("\n")
}

function toolKey(name: string, namespace?: string): string {
  return JSON.stringify([namespace ?? null, name])
}

function translateInput(
  input: ResponsesPayload["input"],
  toolNames: ResponsesToolNames,
): Array<Message> {
  if (typeof input === "string") return [{ role: "user", content: input }]

  const messages: Array<Message> = []
  for (const item of input) {
    switch (item.type) {
      case "message": {
        messages.push(translateMessage(item))
        break
      }
      case "additional_tools": {
        if (item.role !== "developer" || !Array.isArray(item.tools)) {
          unsupported("additional_tools requires developer role and tools")
        }
        break
      }
      case "function_call": {
        messages.push(translateFunctionCall(item, toolNames))
        break
      }
      case "function_call_output": {
        messages.push(translateFunctionOutput(item))
        break
      }
      default: {
        unsupported(`input item type '${item.type}' is not supported`)
      }
    }
  }
  return messages
}

function translateMessage(item: ResponseInputItem): Message {
  if (!item.role || item.content === undefined) {
    unsupported("message.role and message.content are required")
  }
  return {
    role: item.role,
    content: contentToChat(item.content),
  }
}

function translateFunctionCall(
  item: ResponseInputItem,
  toolNames: ResponsesToolNames,
): Message {
  if (!item.call_id || !item.name || item.arguments === undefined) {
    unsupported("function_call.call_id, name, and arguments are required")
  }
  const mappedName =
    toolNames.toCopilot.get(toolKey(item.name, item.namespace))
    ?? (item.namespace ? undefined : item.name)
  if (!mappedName) {
    unsupported(
      `function_call references unknown namespace tool '${item.namespace}.${item.name}'`,
    )
  }
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: item.call_id,
        type: "function",
        function: { name: mappedName, arguments: item.arguments },
      },
    ],
  }
}

function translateFunctionOutput(item: ResponseInputItem): Message {
  if (!item.call_id || item.output === undefined) {
    unsupported("function_call_output.call_id and output are required")
  }
  return {
    role: "tool",
    tool_call_id: item.call_id,
    content: outputToText(item.output),
  }
}

interface ToolDefinition {
  name: string
  namespace?: string
  namespaceDescription?: string
  description?: string
  parameters: Record<string, unknown>
}

function collectTools(payload: ResponsesPayload): Array<ToolDefinition> {
  const declared: Array<ResponseTool> = [...(payload.tools ?? [])]
  if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      if (item.type !== "additional_tools") continue
      if (item.role !== "developer" || !Array.isArray(item.tools)) {
        unsupported("additional_tools requires developer role and tools")
      }
      declared.push(...item.tools)
    }
  }

  const definitions = new Map<string, ToolDefinition>()
  const add = (definition: ToolDefinition) => {
    const key = toolKey(definition.name, definition.namespace)
    const existing = definitions.get(key)
    if (existing && JSON.stringify(existing) !== JSON.stringify(definition)) {
      unsupported(
        `conflicting tool declaration for '${definition.namespace ? `${definition.namespace}.` : ""}${definition.name}'`,
      )
    }
    definitions.set(key, existing ?? definition)
  }

  for (const tool of declared) {
    if (isFunctionTool(tool)) {
      add(functionDefinition(tool))
      continue
    }
    if (!isNamespaceTool(tool)) {
      unsupported(`tool type '${tool.type}' is not supported`)
    }
    if (!tool.name || !Array.isArray(tool.tools)) {
      unsupported("namespace tools require name and tools")
    }
    for (const nested of tool.tools) {
      if (nested.type !== "function") {
        unsupported(
          `namespace '${tool.name}' tool type '${nested.type}' is not supported`,
        )
      }
      add({
        ...functionDefinition(nested),
        namespace: tool.name,
        namespaceDescription: tool.description,
      })
    }
  }
  return [...definitions.values()]
}

function functionDefinition(tool: ResponseFunctionTool): ToolDefinition {
  if (
    typeof tool.name !== "string"
    || tool.name.length === 0
    || !isRecord(tool.parameters)
  ) {
    unsupported("function tools require name and parameters")
  }
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFunctionTool(tool: ResponseTool): tool is ResponseFunctionTool {
  return tool.type === "function"
}

function isNamespaceTool(tool: ResponseTool): tool is ResponseNamespaceTool {
  return tool.type === "namespace"
}

function createToolNames(
  definitions: Array<ToolDefinition>,
): ResponsesToolNames {
  const fromCopilot = new Map<string, { name: string; namespace?: string }>()
  const toCopilot = new Map<string, string>()
  const reserved = new Set(
    definitions.filter((tool) => !tool.namespace).map((tool) => tool.name),
  )
  if (reserved.size !== definitions.filter((tool) => !tool.namespace).length) {
    unsupported("duplicate flat function tool name")
  }

  for (const definition of definitions.filter((tool) => !tool.namespace)) {
    fromCopilot.set(definition.name, { name: definition.name })
    toCopilot.set(toolKey(definition.name), definition.name)
  }

  const namespaced = definitions
    .filter((tool) => tool.namespace)
    .sort((left, right) =>
      toolKey(left.name, left.namespace).localeCompare(
        toolKey(right.name, right.namespace),
      ),
    )
  const preferredCounts = new Map<string, number>()
  for (const definition of namespaced) {
    const preferred = preferredToolName(definition)
    preferredCounts.set(preferred, (preferredCounts.get(preferred) ?? 0) + 1)
  }

  for (const definition of namespaced) {
    const preferred = preferredToolName(definition)
    let flattened =
      preferredCounts.get(preferred) === 1 && !reserved.has(preferred) ?
        preferred
      : hashedToolName(definition, 0)
    for (let attempt = 1; reserved.has(flattened); attempt++) {
      flattened = hashedToolName(definition, attempt)
    }
    reserved.add(flattened)
    fromCopilot.set(flattened, {
      name: definition.name,
      namespace: definition.namespace,
    })
    toCopilot.set(toolKey(definition.name, definition.namespace), flattened)
  }
  return { fromCopilot, toCopilot }
}

function preferredToolName(definition: ToolDefinition): string {
  const name = `${definition.namespace}__${definition.name}`.replaceAll(
    /[^\w-]/g,
    "_",
  )
  return name.slice(0, 64)
}

function hashedToolName(definition: ToolDefinition, attempt: number): string {
  const digest = createHash("sha256")
    .update(`${attempt}\0${definition.namespace}\0${definition.name}`)
    .digest("base64url")
  return `ns_${digest}`
}

function translateTools(
  definitions: Array<ToolDefinition>,
  toolNames: ResponsesToolNames,
): Array<Tool> | undefined {
  if (definitions.length === 0) return undefined
  return definitions.map((tool) => ({
    type: "function",
    function: {
      name:
        toolNames.toCopilot.get(toolKey(tool.name, tool.namespace))
        ?? tool.name,
      description:
        tool.namespaceDescription ?
          `${tool.namespaceDescription}\n\n${tool.description ?? ""}`.trim()
        : tool.description,
      parameters: tool.parameters,
    },
  }))
}

export function createResponsesTranslation(
  payload: ResponsesPayload,
): ResponsesTranslation {
  if (!payload.model) unsupported("model is required")
  if (payload.store === true) unsupported("store=true is not supported")
  if (payload.previous_response_id) {
    unsupported(
      "previous_response_id is not supported; send full input history",
    )
  }
  if (payload.service_tier) unsupported("service_tier is not supported")
  if (payload.truncation && payload.truncation !== "disabled") {
    unsupported("automatic truncation is not supported")
  }
  let responseFormat: ChatCompletionsPayload["response_format"]
  if (payload.text?.format?.type === "json_schema") {
    responseFormat = {
      type: "json_schema",
      json_schema: {
        name: payload.text.format.name,
        description: payload.text.format.description,
        schema: payload.text.format.schema,
        strict: payload.text.format.strict,
      },
    }
  }

  const definitions = collectTools(payload)
  const toolNames = createToolNames(definitions)
  return {
    chatPayload: {
      model: payload.model,
      messages: translateInput(payload.input, toolNames),
      stream: payload.stream ?? false,
      tools: translateTools(definitions, toolNames),
      tool_choice: payload.tool_choice,
      parallel_tool_calls: payload.parallel_tool_calls,
      reasoning_effort: payload.reasoning?.effort,
      verbosity: payload.text?.verbosity,
      response_format: responseFormat,
    },
    toolNames,
  }
}

export function translateResponsesRequest(
  payload: ResponsesPayload,
): ChatCompletionsPayload {
  return createResponsesTranslation(payload).chatPayload
}

function usageFromChat(
  usage: ChatCompletionResponse["usage"] | ChatCompletionChunk["usage"],
): ResponseUsage {
  const input = usage?.prompt_tokens ?? 0
  const output = usage?.completion_tokens ?? 0
  return {
    input_tokens: input,
    input_tokens_details: {
      cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    output_tokens: output,
    output_tokens_details: {
      reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    },
    total_tokens: usage?.total_tokens ?? input + output,
  }
}

export function translateResponsesResult(
  response: ChatCompletionResponse,
  request: ResponsesPayload,
  toolNames?: ResponsesToolNames,
): ResponsesResult {
  const output: Array<ResponseOutputItem> = []
  for (const [choiceIndex, choice] of response.choices.entries()) {
    if (choice.message.content) {
      output.push({
        type: "message",
        id: `msg_${response.id}_${choiceIndex}`,
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: choice.message.content,
            annotations: [],
          },
        ],
      })
    }
    for (const [toolIndex, tool] of (
      choice.message.tool_calls ?? []
    ).entries()) {
      const original = toolNames?.fromCopilot.get(tool.function.name)
      output.push({
        type: "function_call",
        id: `fc_${response.id}_${choiceIndex}_${toolIndex}`,
        status: "completed",
        call_id: tool.id,
        name: original?.name ?? tool.function.name,
        namespace: original?.namespace,
        arguments: tool.function.arguments,
      })
    }
  }

  return {
    id: response.id,
    object: "response",
    created_at: response.created,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: response.model,
    output,
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    store: false,
    tool_choice: request.tool_choice ?? "auto",
    tools: request.tools ?? [],
    usage: usageFromChat(response.usage),
  }
}

export function createStreamState(
  model: string,
  toolNames?: ResponsesToolNames,
): ResponsesStreamState {
  return {
    model,
    created: false,
    text: "",
    textItemAdded: false,
    tools: new Map(),
    toolNames,
  }
}

export function translateStreamChunk(
  chunk: ChatCompletionChunk,
  state: ResponsesStreamState,
): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = []
  state.responseId ??= chunk.id
  state.model = chunk.model || state.model
  if (!state.created) {
    state.created = true
    output.push({
      type: "response.created",
      response: {
        id: state.responseId,
        object: "response",
        status: "in_progress",
        model: state.model,
      },
    })
  }
  if (chunk.usage) state.usage = chunk.usage

  for (const choice of chunk.choices) {
    appendTextDelta(choice.delta.content, state, output)
    appendToolDeltas(choice.delta.tool_calls, state, output)
  }
  return output
}

function appendTextDelta(
  delta: string | null | undefined,
  state: ResponsesStreamState,
  output: Array<Record<string, unknown>>,
) {
  if (!delta) return
  state.textItemId ??= `msg_${state.responseId}`
  if (!state.textItemAdded) {
    state.textItemAdded = true
    output.push({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: state.textItemId,
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    })
  }
  state.text += delta
  output.push({
    type: "response.output_text.delta",
    item_id: state.textItemId,
    output_index: 0,
    content_index: 0,
    delta,
  })
}

function appendToolDeltas(
  deltas: ChatCompletionChunk["choices"][number]["delta"]["tool_calls"],
  state: ResponsesStreamState,
  output: Array<Record<string, unknown>>,
) {
  for (const delta of deltas ?? []) {
    const tool = getStreamTool(delta, state)
    if (delta.id) tool.callId = delta.id
    if (delta.function?.name) tool.name += delta.function.name
    if (delta.function?.arguments) {
      tool.arguments += delta.function.arguments
    }
    const outputIndex = state.textItemAdded ? delta.index + 1 : delta.index
    addStreamTool(tool, outputIndex, { state, output })
    appendStreamToolArguments(tool, outputIndex, output)
  }
}

type StreamTool =
  ResponsesStreamState["tools"] extends Map<number, infer Tool> ? Tool : never
type ToolDelta = NonNullable<
  ChatCompletionChunk["choices"][number]["delta"]["tool_calls"]
>[number]
interface StreamToolOutputContext {
  state: ResponsesStreamState
  output: Array<Record<string, unknown>>
}

function getStreamTool(
  delta: ToolDelta,
  state: ResponsesStreamState,
): StreamTool {
  const existing = state.tools.get(delta.index)
  if (existing) return existing
  const tool: StreamTool = {
    id: `fc_${state.responseId}_${delta.index}`,
    callId: delta.id ?? `call_${randomUUID()}`,
    name: "",
    arguments: "",
    emittedArgumentLength: 0,
    added: false,
  }
  state.tools.set(delta.index, tool)
  return tool
}

function addStreamTool(
  tool: StreamTool,
  outputIndex: number,
  context: StreamToolOutputContext,
) {
  const original = context.state.toolNames?.fromCopilot.get(tool.name)
  if (tool.added || !tool.name || (!original && context.state.toolNames)) {
    return
  }
  tool.added = true
  tool.responseName = original?.name ?? tool.name
  tool.namespace = original?.namespace
  context.output.push({
    type: "response.output_item.added",
    output_index: outputIndex,
    item: {
      type: "function_call",
      id: tool.id,
      status: "in_progress",
      call_id: tool.callId,
      name: tool.responseName,
      namespace: tool.namespace,
      arguments: "",
    },
  })
}

function appendStreamToolArguments(
  tool: StreamTool,
  outputIndex: number,
  output: Array<Record<string, unknown>>,
) {
  if (!tool.added || tool.arguments.length <= tool.emittedArgumentLength) return
  const argumentDelta = tool.arguments.slice(tool.emittedArgumentLength)
  tool.emittedArgumentLength = tool.arguments.length
  output.push({
    type: "response.function_call_arguments.delta",
    item_id: tool.id,
    output_index: outputIndex,
    delta: argumentDelta,
  })
}

export function completeStream(
  state: ResponsesStreamState,
): Array<Record<string, unknown>> {
  state.responseId ??= `resp_${randomUUID()}`
  const output: Array<Record<string, unknown>> = []
  const finalItems: Array<ResponseOutputItem> = []

  if (state.textItemAdded && state.textItemId) {
    const item: ResponseOutputItem = {
      type: "message",
      id: state.textItemId,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: state.text, annotations: [] }],
    }
    finalItems.push(item)
    output.push({ type: "response.output_item.done", output_index: 0, item })
  }

  for (const [index, tool] of state.tools) {
    const original = state.toolNames?.fromCopilot.get(tool.name)
    if (state.toolNames && !original) {
      unsupported(`Copilot returned unknown tool '${tool.name}'`)
    }
    const item: ResponseOutputItem = {
      type: "function_call",
      id: tool.id,
      status: "completed",
      call_id: tool.callId,
      name: tool.responseName ?? original?.name ?? tool.name,
      namespace: tool.namespace ?? original?.namespace,
      arguments: tool.arguments,
    }
    finalItems.push(item)
    output.push({
      type: "response.output_item.done",
      output_index: state.textItemAdded ? index + 1 : index,
      item,
    })
  }

  output.push({
    type: "response.completed",
    response: {
      id: state.responseId,
      object: "response",
      status: "completed",
      model: state.model,
      output: finalItems,
      usage: usageFromChat(state.usage),
    },
  })
  return output
}
