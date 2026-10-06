export function formatOpenAiPayload(model, systemPrompt, userPrompt) {
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3, // steadier, more literal notes; the prompt is a strict format
    stream: false,
  };
}

export async function generateCompletion(aiConfig, systemPrompt, userPrompt) {
  const payload = formatOpenAiPayload(aiConfig.model, systemPrompt, userPrompt);
  const response = await fetch(`${aiConfig.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(aiConfig.apiKey ? { Authorization: `Bearer ${aiConfig.apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
    // A hung provider would otherwise stall the request (and runDailyInsights,
    // which walks users one at a time) indefinitely.
    signal: AbortSignal.timeout(aiConfig.timeoutMs ?? 120_000),
  });

  if (!response.ok) {
    throw new Error(`LLM provider error: ${response.statusText}`);
  }

  const data = await response.json();
  const choice = data.choices && data.choices[0];
  return {
    text: choice ? choice.message.content : '',
    promptTokens: data.usage ? data.usage.prompt_tokens : 0,
    completionTokens: data.usage ? data.usage.completion_tokens : 0,
  };
}
