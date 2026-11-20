import { describe, expect, test } from "bun:test"

import type { ResponsesPayload } from "~/routes/responses/types"
import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import {
  completeStream,
  createResponsesTranslation,
  createStreamState,
  translateResponsesRequest,
  translateResponsesResult,
  translateStreamChunk,
  UnsupportedResponsesFeatureError,
} from "../src/routes/responses/translation"

describe("Codex Responses request translation", () => {
  test("translates captured top-level flat and namespace tools", async () => {
    const payload = await fixture("codex-namespace-tools.json")
    const { chatPayload, toolNames } = createResponsesTranslation(payload)

    expect(chatPayload.tools).toHaveLength(2)
    expect(chatPayload.tools?.[0]).toMatchObject({
      type: "function",
      function: {
        name: "read_file",
        description: "Read one file",
      },
    })
    expect(chatPayload.tools?.[0]?.function.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    })
    expect(chatPayload.tools?.[1]).toMatchObject({
      type: "function",
      function: {
        name: "multi_agent_v1__spawn_agent",
        description: "Coordinate local agents\n\nStart one agent",
      },
    })
    expect(toolNames.fromCopilot.get("multi_agent_v1__spawn_agent")).toEqual({
      name: "spawn_agent",
      namespace: "multi_agent_v1",
    })
  })

  test("translates captured additional_tools without adding a message", async () => {
    const payload = await fixture("codex-additional-tools.json")
    const { chatPayload, toolNames } = createResponsesTranslation(payload)

    expect(chatPayload.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Inspect the workspace." }],
      },
    ])
    expect(chatPayload.tools).toEqual([
      {
        type: "function",
        function: {
          name: "functions__exec_command",
          description: "Local Codex tools\n\nRun a local command",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
            additionalProperties: false,
          },
        },
      },
    ])
    expect(
      toolNames.toCopilot.get(JSON.stringify(["functions", "exec_command"])),
    ).toBe("functions__exec_command")
  })

  test("maps historical namespaced calls and correlated results", () => {
    const { chatPayload } = createResponsesTranslation({
      model: "gpt-test",
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          namespace: "functions",
          name: "exec_command",
          arguments: '{"cmd":"pwd"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: String.raw`C:\work`,
        },
      ],
      tools: [namespaceTool("functions", "exec_command")],
    })

    expect(chatPayload.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "functions__exec_command",
              arguments: '{"cmd":"pwd"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: String.raw`C:\work` },
    ])
  })

  test("uses deterministic collision-safe names", () => {
    const payload: ResponsesPayload = {
      model: "gpt-test",
      input: "test",
      tools: [
        functionTool("a__b"),
        namespaceTool("a", "b"),
        namespaceTool("a.", "b"),
        namespaceTool("a_", "b"),
      ],
    }
    const first = createResponsesTranslation(payload)
    const second = createResponsesTranslation(payload)
    const firstNames = first.chatPayload.tools?.map(
      (tool) => tool.function.name,
    )
    const secondNames = second.chatPayload.tools?.map(
      (tool) => tool.function.name,
    )

    expect(firstNames).toEqual(secondNames)
    expect(new Set(firstNames).size).toBe(4)
    expect(firstNames?.[0]).toBe("a__b")
    expect(firstNames?.slice(1).every((name) => /^ns_[\w-]+$/.test(name))).toBe(
      true,
    )
    expect(firstNames?.every((name) => name.length <= 64)).toBe(true)
  })
})

describe("Codex Responses base request translation", () => {
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

  test("omits optional tool settings without declarations", () => {
    const translated = translateResponsesRequest({
      model: "gpt-test",
      input: "No tools",
      tool_choice: "auto",
      parallel_tool_calls: true,
    })
    const serialized = JSON.stringify(translated)
    expect(serialized).not.toContain('"tool_choice"')
    expect(serialized).not.toContain('"parallel_tool_calls"')
    expect(serialized).not.toContain('"tools"')

    expect(() =>
      translateResponsesRequest({
        model: "gpt-test",
        input: "A tool is required",
        tool_choice: "required",
      }),
    ).toThrow("tool_choice=required requires at least one function tool")
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

  test("rejects malformed nested tools and unknown historical calls", () => {
    expect(() =>
      createResponsesTranslation({
        model: "gpt-test",
        input: "test",
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [{ type: "function", name: "broken" }],
          },
        ],
      }),
    ).toThrow("function tools require name and parameters")

    expect(() =>
      createResponsesTranslation({
        model: "gpt-test",
        input: [
          {
            type: "function_call",
            call_id: "call_1",
            namespace: "missing",
            name: "tool",
            arguments: "{}",
          },
        ],
      }),
    ).toThrow("references unknown namespace tool")

    const valid = createResponsesTranslation({
      model: "gpt-test",
      input: "still isolated",
      tools: [namespaceTool("functions", "exec_command")],
    })
    expect(valid.chatPayload.tools?.[0]?.function.name).toBe(
      "functions__exec_command",
    )
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

describe("Codex Responses namespace result translation", () => {
  test("restores namespace for non-streaming and fragmented streaming calls", () => {
    const translation = createResponsesTranslation({
      model: "gpt-test",
      input: "use a tool",
      tools: [namespaceTool("functions", "exec_command")],
    })
    const flattened = translation.chatPayload.tools?.[0]?.function.name ?? ""
    const response = {
      id: "chatcmpl_ns",
      object: "chat.completion" as const,
      created: 123,
      model: "gpt-test",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: null,
            tool_calls: [
              {
                id: "call_ns",
                type: "function" as const,
                function: { name: flattened, arguments: '{"cmd":"pwd"}' },
              },
            ],
          },
          logprobs: null,
          finish_reason: "tool_calls" as const,
        },
      ],
    }
    expect(
      translateResponsesResult(
        response,
        { model: "gpt-test", input: "use a tool" },
        translation.toolNames,
      ).output[0],
    ).toMatchObject({
      type: "function_call",
      name: "exec_command",
      namespace: "functions",
    })

    const state = createStreamState("gpt-test", translation.toolNames)
    const split = Math.floor(flattened.length / 2)
    const events = [
      ...translateStreamChunk(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_ns",
              function: {
                name: flattened.slice(0, split),
                arguments: '{"cmd":',
              },
            },
          ],
        }),
        state,
      ),
      ...translateStreamChunk(
        chunk({
          tool_calls: [
            {
              index: 0,
              function: {
                name: flattened.slice(split),
                arguments: '"pwd"}',
              },
            },
          ],
        }),
        state,
      ),
      ...completeStream(state),
    ]
    const added = events.find(
      (event) => event.type === "response.output_item.added",
    )
    expect(added?.item).toMatchObject({
      name: "exec_command",
      namespace: "functions",
    })
    expect(
      events
        .filter(
          (event) => event.type === "response.function_call_arguments.delta",
        )
        .map((event) => event.delta)
        .join(""),
    ).toBe('{"cmd":"pwd"}')
  })
})

async function fixture(name: string): Promise<ResponsesPayload> {
  const payload: unknown = await Bun.file(
    new URL(`fixtures/${name}`, import.meta.url),
  ).json()
  return payload as ResponsesPayload
}

function functionTool(name: string) {
  return {
    type: "function" as const,
    name,
    description: `Use ${name}`,
    parameters: { type: "object", properties: {} },
  }
}

function namespaceTool(namespace: string, name: string) {
  return {
    type: "namespace" as const,
    name: namespace,
    description: `Use ${namespace}`,
    tools: [functionTool(name)],
  }
}

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
