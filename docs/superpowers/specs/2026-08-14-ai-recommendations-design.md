# AI Recommendations & Daily Review — Design

**Date:** 2026-08-14  
**Status:** Approved  
**Scope:** Web Receiver/Server (`web/`) + Android deep link integration  

---

## 1. Summary

Vitalix allows users to view a **Daily Review** of their Health Connect data, comparing daily metrics against previous days and rolling averages. This feature integrates **AI Recommendations** generated from daily health trends using self-hosted LLMs (e.g. Ollama, LocalAI) or cloud providers (OpenAI, Anthropic, OpenRouter).

---

## 2. Requirements & Architecture

### 2.1 Daily Review
- Route: `/daily-review` (defaults to today) or `/days/:date` (e.g., `/days/2026-08-14`).
- Computes metrics for the requested `day`, comparison deltas vs `day - 1d`, and a 7-day rolling baseline average (`day - 7d` to `day - 1d`).
- Displays summary cards for Steps, Active/Total Calories, Distance, Sleep Duration/Phases, Resting Heart Rate, Weight, BMI, Hydration, and Workout sessions.

### 2.2 AI Recommendation Engine
- **Providers Supported**:
  - OpenAI-compatible endpoints (`/v1/chat/completions`) for Ollama, LocalAI, vLLM, OpenAI, OpenRouter.
  - Anthropic Messages API (`/v1/messages`).
- **Configuration (per user in DB / settings modal)**:
  - Provider type (`openai-compatible` | `anthropic`).
  - Base URL (default: `http://localhost:11434/v1` for Ollama).
  - API Key (encrypted/hashed at rest if set).
  - Model ID (e.g., `llama3:latest`, `gpt-4o-mini`, `claude-3-5-haiku`).
  - Custom System Prompt template.
  - Anonymization toggle (removes specific user name/email from prompt context).
- **Caching & Persistence**:
  - Store generated recommendations in `ai_recommendations` PostgreSQL table.
  - Re-generate on demand via UI button or auto-generate on viewing a new complete day.

---

## 3. Database Schema

### Migration: `1722700000000_ai_recommendations.cjs`

```sql
CREATE TABLE IF NOT EXISTS ai_recommendations (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    recommendation_text TEXT NOT NULL,
    metrics_snapshot JSONB NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ai_recommendations_user_day_key UNIQUE (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_ai_recommendations_user_day ON ai_recommendations(user_id, day);

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS ai_config JSONB DEFAULT '{
  "enabled": false,
  "provider": "openai-compatible",
  "baseUrl": "http://localhost:11434/v1",
  "apiKey": "",
  "model": "llama3:latest",
  "anonymize": true
}'::jsonb;
```

---

## 4. API Endpoints

### 4.1 Daily Review Data API
- `GET /api/daily-review?day=YYYY-MM-DD`
- **Response**:
  ```json
  {
    "day": "2026-08-14",
    "metrics": {
      "steps": 9420,
      "activeCalories": 420.5,
      "restingHeartRate": 62,
      "sleepMinutes": 450,
      "weight": 75.2,
      "bmi": 23.4
    },
    "deltas": {
      "steps": 1200,
      "restingHeartRate": -2,
      "sleepMinutes": 30
    },
    "baseline7d": {
      "steps": 8500,
      "restingHeartRate": 64,
      "sleepMinutes": 420
    }
  }
  ```

### 4.2 AI Recommendation API
- `GET /api/ai/recommendations?day=YYYY-MM-DD`: Fetches cached recommendation for the day.
- `POST /api/ai/recommendations/generate`: Triggers LLM call, saves to DB, returns Markdown recommendation text.
- `PUT /api/user/ai-config`: Updates user AI provider settings.

---

## 5. Security & Privacy

- All health metrics sent to LLM endpoints are filtered to remove personally identifiable context if `anonymize` is enabled.
- API keys are stored safely and never exposed in frontend responses.
- AI Recommendations carry a clear non-diagnostic disclaimer: *"Vitalix AI Insights are for informational & fitness coaching purposes only, not medical advice."*
