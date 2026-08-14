---
status: Specs Created
---

# Daily Review Pages & AI Recommendations

1. **Daily Review Page**:
   - As a user, I want a Daily Review page (`/daily-review` or `/days/:date`) to inspect all health metrics for a selected day alongside deltas compared to the previous day (`day - 1d`) and a 7-day rolling baseline average.
   - Included metrics: Steps, Active/Total Calories, Distance, Sleep Duration & Phases, Resting Heart Rate, Weight, BMI, Hydration, and Workout/Exercise sessions.

2. **AI Health & Habit Recommendations**:
   - As a user, I want AI-generated daily insights and habit recommendations based on my health metrics, trends, and comparison deltas.
   - Must support self-hosted/local LLM providers (e.g. Ollama or LocalAI via OpenAI-compatible `/v1/chat/completions`) as well as cloud providers (OpenAI, Anthropic, OpenRouter).
   - Configurable settings per user/admin (Provider API Base URL, API Key, Model ID, and custom system prompt template).
   - Privacy & Safety: Provide option to anonymize health metrics before sending data to external APIs, accompanied by non-diagnostic health coaching disclaimers.
   - Support historical recommendation viewing by date, manual regeneration, and persistent caching in PostgreSQL.
