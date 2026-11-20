import { randomUUID } from "node:crypto"

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
  ResponseOutputItem,
  ResponsesPayload,
  ResponsesResult,
  ResponsesStreamState,
  ResponseUsage,
} from "./types"

export class UnsupportedResponsesFeatureError extends Error {
  code = "unsupported_responses_feature"
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

function translateInput(input: ResponsesPayload["input"]): Array<Message> {
  if (typeof input === "string") return [{ role: "user", content: input }]

  const messages: Array<Message> = []
  for (const item of input) {
    switch (item.type) {
      case "message": {
        if (!item.role || item.content === undefined) {
          unsupported("message.role and message.content are required")
        }
        messages.push({
          role: item.role,
          content: contentToChat(item.content),
        })

        break
      }
      case "function_call": {
        if (!item.call_id || !item.name || item.arguments === undefined) {
          unsupported("function_call.call_id, name, and arguments are required")
        }
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: item.call_id,
              type: "function",
              function: { name: item.name, arguments: item.arguments },
            },
          ],
        })

        break
      }
      case "function_call_output": {
        if (!item.call_id || item.output === undefined) {
          unsupported("function_call_output.call_id and output are required")
        }
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: outputToText(item.output),
        })

        break
      }
      default: {
        unsupported(`input item type '${item.type}' is not supported`)
      }
    }
  }
  return messages
}

function translateTools(
  tools: ResponsesPayload["tools"],
): Array<Tool> | undefined {
  return tools?.map((tool) => {
    if (tool.type !== "function") {
      unsupported(`tool type '${tool.type}' is not supported`)
    }
    if (!tool.name || !tool.parameters) {
      unsupported("function tools require name and parameters")
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }
  })
}

export function translateResponsesRequest(
  payload: ResponsesPayload,
): ChatCompletionsPayload {
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

  return {
    model: payload.model,
    messages: translateInput(payload.input),
    stream: payload.stream ?? false,
    tools: translateTools(payload.tools),
    tool_choice: payload.tool_choice,
    parallel_tool_calls: payload.parallel_tool_calls,
    reasoning_effort: payload.reasoning?.effort,
    verbosity: payload.text?.verbosity,
    response_format: responseFormat,
  }
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
      output.push({
        type: "function_call",
        id: `fc_${response.id}_${choiceIndex}_${toolIndex}`,
        status: "completed",
        call_id: tool.id,
        name: tool.function.name,
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

export function createStreamState(model: string): ResponsesStreamState {
  return {
    model,
    created: false,
    text: "",
    textItemAdded: false,
    tools: new Map(),
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
    let tool = state.tools.get(delta.index)
    if (!tool) {
      tool = {
        id: `fc_${state.responseId}_${delta.index}`,
        callId: delta.id ?? `call_${randomUUID()}`,
        name: "",
        arguments: "",
        added: false,
      }
      state.tools.set(delta.index, tool)
    }
    if (delta.id) tool.callId = delta.id
    if (delta.function?.name) tool.name += delta.function.name
    const outputIndex = state.textItemAdded ? delta.index + 1 : delta.index
    if (!tool.added && tool.name) {
      tool.added = true
      output.push({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          type: "function_call",
          id: tool.id,
          status: "in_progress",
          call_id: tool.callId,
          name: tool.name,
          arguments: "",
        },
      })
    }
    if (delta.function?.arguments) {
      tool.arguments += delta.function.arguments
      output.push({
        type: "response.function_call_arguments.delta",
        item_id: tool.id,
        output_index: outputIndex,
        delta: delta.function.arguments,
      })
    }
  }
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
    const item: ResponseOutputItem = {
      type: "function_call",
      id: tool.id,
      status: "completed",
      call_id: tool.callId,
      name: tool.name,
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
