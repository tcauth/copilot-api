import { describe, expect, test } from "bun:test"

import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import {
  completeStream,
  createStreamState,
  translateResponsesRequest,
  translateResponsesResult,
  translateStreamChunk,
  UnsupportedResponsesFeatureError,
} from "../src/routes/responses/translation"

describe("Codex Responses request translation", () => {
  test("translates messages, tools, and function results", () => {
    const translated = translateResponsesRequest({
      model: "gpt-5.1-codex",
      stream: true,
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Use tools." }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "shell",
          arguments: '{"command":"git status"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "clean",
        },
      ],
      tools: [
        {
          type: "function",
          name: "shell",
          description: "Run a command",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
          },
          strict: true,
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "high", summary: "auto" },
      store: false,
      include: ["reasoning.encrypted_content"],
    })

    expect(translated).toMatchObject({
      model: "gpt-5.1-codex",
      stream: true,
      reasoning_effort: "high",
      parallel_tool_calls: true,
      messages: [
        {
          role: "developer",
          content: [{ type: "text", text: "Use tools." }],
        },
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", function: { name: "shell" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "clean" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "shell", description: "Run a command" },
        },
      ],
    })
  })

  test("translates structured output", () => {
    const translated = translateResponsesRequest({
      model: "gpt-5.1-codex",
      input: "Return JSON",
      text: {
        format: {
          type: "json_schema",
          name: "result",
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
          },
          strict: true,
        },
      },
    })

    expect(translated.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "result",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
        strict: true,
      },
    })
  })

  test("rejects provider-hosted tools and stored responses", () => {
    expect(() =>
      translateResponsesRequest({
        model: "gpt-5.1-codex",
        input: "Search",
        tools: [{ type: "web_search" }],
      }),
    ).toThrow(UnsupportedResponsesFeatureError)

    expect(() =>
      translateResponsesRequest({
        model: "gpt-5.1-codex",
        input: "Remember",
        store: true,
      }),
    ).toThrow("store=true is not supported")
  })
})

describe("Codex Responses result translation", () => {
  test("preserves IDs, tool calls, and usage", () => {
    const result = translateResponsesResult(
      {
        id: "chatcmpl_1",
        object: "chat.completion",
        created: 123,
        model: "gpt-5.1-codex",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Checking.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "shell", arguments: '{"command":"pwd"}' },
                },
              ],
            },
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      },
      { model: "gpt-5.1-codex", input: "Inspect" },
    )

    expect(result.id).toBe("chatcmpl_1")
    expect(result.output.map((item) => item.type)).toEqual([
      "message",
      "function_call",
    ])
    expect(result.usage).toEqual({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 14,
    })
  })

  test("translates streaming text and tool calls", () => {
    const state = createStreamState("gpt-5.1-codex")
    const chunks: Array<ChatCompletionChunk> = [
      chunk({ role: "assistant", content: "Checking " }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_2",
            type: "function",
            function: { name: "shell", arguments: '{"command":' },
          },
        ],
      }),
      {
        ...chunk({
          tool_calls: [
            {
              index: 0,
              function: { arguments: '"pwd"}' },
            },
          ],
        }),
        usage: {
          prompt_tokens: 11,
          completion_tokens: 5,
          total_tokens: 16,
        },
      },
    ]

    const events = [
      ...chunks.flatMap((value) => translateStreamChunk(value, state)),
      ...completeStream(state),
    ]

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.output_item.done",
      "response.output_item.done",
      "response.completed",
    ])
    const toolDone = events.find(
      (event) =>
        event.type === "response.output_item.done"
        && (event.item as { type?: string }).type === "function_call",
    )
    expect(toolDone?.item).toMatchObject({
      call_id: "call_2",
      name: "shell",
      arguments: '{"command":"pwd"}',
    })
    const completed = events.at(-1) as {
      response: { usage: { total_tokens: number } }
    }
    expect(completed.response.usage.total_tokens).toBe(16)
  })
})

function chunk(
  delta: ChatCompletionChunk["choices"][number]["delta"],
): ChatCompletionChunk {
  return {
    id: "chatcmpl_2",
    object: "chat.completion.chunk",
    created: 123,
    model: "gpt-5.1-codex",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
}
