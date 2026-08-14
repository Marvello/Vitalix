export function formatOpenAiPayload(model, systemPrompt, userPrompt) {
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
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
