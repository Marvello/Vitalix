import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatOpenAiPayload, generateCompletion } from "../src/ai/llmClient.js";

describe("LLM Client Payload Formatters", () => {
  test("formatOpenAiPayload constructs correct request structure", () => {
    const payload = formatOpenAiPayload("llama3:latest", "System prompt", "User metrics");
    assert.equal(payload.model, "llama3:latest");
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.messages[0].role, "system");
    assert.equal(payload.messages[0].content, "System prompt");
    assert.equal(payload.messages[1].role, "user");
    assert.equal(payload.messages[1].content, "User metrics");
  });

  test("generateCompletion calls fetch and parses success response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "http://localhost:11434/v1/chat/completions");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.equal(options.headers["Authorization"], "Bearer test-key");

      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Test completion response" } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
      };
    };

    try {
      const aiConfig = {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "test-key",
        model: "llama3:latest",
      };
      const result = await generateCompletion(aiConfig, "System", "User");
      assert.equal(result.text, "Test completion response");
      assert.equal(result.promptTokens, 10);
      assert.equal(result.completionTokens, 20);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("generateCompletion throws error on non-ok HTTP response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      statusText: "Internal Server Error",
    });

    try {
      const aiConfig = {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "",
        model: "llama3:latest",
      };
      await assert.rejects(
        () => generateCompletion(aiConfig, "System", "User"),
        { message: "LLM provider error: Internal Server Error" }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
