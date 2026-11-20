import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import type { ResponsesPayload } from "./types"

import {
  completeStream,
  createResponsesTranslation,
  createStreamState,
  translateResponsesResult,
  translateStreamChunk,
} from "./translation"

export async function handleResponse(c: Context) {
  await checkRateLimit(state)
  const payload = await c.req.json<ResponsesPayload>()

  if (!state.copilotToken) {
    return c.json(
      {
        error: {
          message: "Copilot authentication is not initialized",
          type: "authentication_error",
          code: "copilot_auth_missing",
        },
      },
      401,
    )
  }
  if (
    state.models
    && !state.models.data.some((model) => model.id === payload.model)
  ) {
    return c.json(
      {
        error: {
          message: `Model '${payload.model}' is not available from Copilot`,
          type: "invalid_request_error",
          code: "model_not_found",
        },
      },
      400,
    )
  }

  const { chatPayload, toolNames } = createResponsesTranslation(payload)
  if (state.manualApprove) await awaitApproval()
  const response = await createChatCompletions(chatPayload, c.req.raw.signal)

  if (isNonStreaming(response)) {
    return c.json(translateResponsesResult(response, payload, toolNames))
  }

  return streamSSE(c, async (stream) => {
    const streamState = createStreamState(payload.model, toolNames)
    try {
      for await (const rawEvent of response) {
        if (rawEvent.data === "[DONE]") break
        if (!rawEvent.data) continue

        const eventData = JSON.parse(rawEvent.data) as unknown
        if (isStreamError(eventData)) {
          await writeFailedEvent(
            stream,
            streamState.responseId,
            eventData.error,
          )
          return
        }
        if (!isChatCompletionChunk(eventData)) {
          throw new Error("Copilot returned an invalid streaming event")
        }
        for (const event of translateStreamChunk(eventData, streamState)) {
          await stream.writeSSE({
            event: event.type as string,
            data: JSON.stringify(event),
          })
        }
      }
      for (const event of completeStream(streamState)) {
        await stream.writeSSE({
          event: event.type as string,
          data: JSON.stringify(event),
        })
      }
    } catch (error) {
      await writeFailedEvent(stream, streamState.responseId, {
        code: "copilot_stream_error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

function isStreamError(
  value: unknown,
): value is { error: { code?: string; message?: string } } {
  return (
    typeof value === "object"
    && value !== null
    && "error" in value
    && typeof value.error === "object"
    && value.error !== null
  )
}

function isChatCompletionChunk(value: unknown): value is ChatCompletionChunk {
  return (
    typeof value === "object"
    && value !== null
    && "id" in value
    && typeof value.id === "string"
    && "choices" in value
    && Array.isArray(value.choices)
  )
}

async function writeFailedEvent(
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  responseId: string | undefined,
  error: { code?: string; message?: string },
) {
  const event = {
    type: "response.failed",
    response: {
      id: responseId,
      status: "failed",
      error: {
        code: error.code ?? "copilot_stream_error",
        message: error.message ?? "Copilot stream failed",
      },
    },
  }
  await stream.writeSSE({
    event: event.type,
    data: JSON.stringify(event),
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
