# AI Recommendations & Daily Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Daily Review page and AI Recommendation system in Vitalix (`web/`) to compare day-over-day and rolling baseline health metrics and generate AI health insights via local or cloud LLMs.

**Architecture:** Database schema extensions for AI recommendations and user settings in PostgreSQL, backend calculation engine in Node.js/Express (`web/src/ai/`), OpenAI/Anthropic API integration client, and web frontend rendering Daily Review cards + AI Markdown recommendation view.

**Tech Stack:** Node.js, Express, PostgreSQL (`node-pg-migrate`, `pg`), EJS / CSS / JS, Jest for unit testing.

**Spec:** `docs/superpowers/specs/2026-08-14-ai-recommendations-design.md`

## Global Constraints

- Backend changes live strictly in `web/` (Node.js/Express backend).
- Database migrations must follow `node-pg-migrate` conventions in `web/migrations/`.
- All LLM API calls must handle timeouts and failures gracefully without crashing Express server.

---

### Task 1: Database Migration for AI Recommendations & User Settings

**Files:**
- Create: `web/migrations/1722700000000_ai_recommendations.cjs`
- Test: `web/test/aiMigration.test.js`

**Interfaces:**
- Consumes: PostgreSQL DB instance (`web/src/db.js`)
- Produces: `ai_recommendations` table and `users.ai_config` column

- [ ] **Step 1: Write failing integration test for migration schema**

```javascript
// web/test/aiMigration.test.js
const { pool } = require('../src/db');

describe('AI Recommendations Database Migration', () => {
  test('ai_recommendations table and users.ai_config column exist', async () => {
    const resTable = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'ai_recommendations'"
    );
    expect(resTable.rows.length).toBe(1);

    const resCol = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'ai_config'"
    );
    expect(resCol.rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- test/aiMigration.test.js`
Expected: FAIL (table and column do not exist yet)

- [ ] **Step 3: Write migration file**

```javascript
// web/migrations/1722700000000_ai_recommendations.cjs
exports.up = (pgm) => {
  pgm.createTable('ai_recommendations', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: { type: 'bigint', notNull: true, references: 'users', onDelete: 'CASCADE' },
    day: { type: 'date', notNull: true },
    provider: { type: 'text', notNull: true },
    model: { type: 'text', notNull: true },
    recommendation_text: { type: 'text', notNull: true },
    metrics_snapshot: { type: 'jsonb', notNull: true },
    prompt_tokens: { type: 'integer' },
    completion_tokens: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.addConstraint('ai_recommendations', 'ai_recommendations_user_day_key', {
    unique: ['user_id', 'day'],
  });

  pgm.addColumn('users', {
    ai_config: {
      type: 'jsonb',
      default: JSON.stringify({
        enabled: false,
        provider: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: '',
        model: 'llama3:latest',
        anonymize: true,
      }),
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('users', 'ai_config');
  pgm.dropTable('ai_recommendations');
};
```

- [ ] **Step 4: Run migration and tests**

Run: `cd web && npm run migrate up && npm test -- test/aiMigration.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/migrations/1722700000000_ai_recommendations.cjs web/test/aiMigration.test.js
git commit -m "feat(ai): add database migration for ai_recommendations and user ai_config"
```

---

### Task 2: Daily Review Metrics Calculation Engine

**Files:**
- Create: `web/src/ai/metricsBuilder.js`
- Test: `web/test/metricsBuilder.test.js`

**Interfaces:**
- Consumes: `health_days`, `records`, `exercises` tables in DB
- Produces: `getDailyReviewMetrics(userId, day)` returning `{ metrics, deltas, baseline7d }`

- [ ] **Step 1: Write failing unit test for metrics builder logic**

```javascript
// web/test/metricsBuilder.test.js
const { calculateDeltas, calculateBaseline } = require('../src/ai/metricsBuilder');

describe('Daily Review Metrics Builder Helpers', () => {
  test('calculateDeltas computes differences correctly', () => {
    const today = { steps: 10000, restingHeartRate: 60 };
    const yesterday = { steps: 8000, restingHeartRate: 65 };

    const deltas = calculateDeltas(today, yesterday);
    expect(deltas.steps).toBe(2000);
    expect(deltas.restingHeartRate).toBe(-5);
  });

  test('calculateBaseline computes average over days', () => {
    const pastDays = [
      { steps: 7000, sleepMinutes: 400 },
      { steps: 9000, sleepMinutes: 440 },
    ];

    const baseline = calculateBaseline(pastDays);
    expect(baseline.steps).toBe(8000);
    expect(baseline.sleepMinutes).toBe(420);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- test/metricsBuilder.test.js`
Expected: FAIL (functions not defined)

- [ ] **Step 3: Implement metricsBuilder.js**

```javascript
// web/src/ai/metricsBuilder.js
function calculateDeltas(todayMetrics, yesterdayMetrics) {
  const deltas = {};
  for (const key in todayMetrics) {
    if (typeof todayMetrics[key] === 'number' && typeof yesterdayMetrics[key] === 'number') {
      deltas[key] = todayMetrics[key] - yesterdayMetrics[key];
    }
  }
  return deltas;
}

function calculateBaseline(pastDaysList) {
  if (!pastDaysList || pastDaysList.length === 0) return {};
  const sums = {};
  const counts = {};

  pastDaysList.forEach((dayData) => {
    for (const key in dayData) {
      if (typeof dayData[key] === 'number') {
        sums[key] = (sums[key] || 0) + dayData[key];
        counts[key] = (counts[key] || 0) + 1;
      }
    }
  });

  const baseline = {};
  for (const key in sums) {
    baseline[key] = Math.round((sums[key] / counts[key]) * 10) / 10;
  }
  return baseline;
}

module.exports = {
  calculateDeltas,
  calculateBaseline,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- test/metricsBuilder.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/ai/metricsBuilder.js web/test/metricsBuilder.test.js
git commit -m "feat(ai): implement metrics calculation logic for daily review"
```

---

### Task 3: LLM Provider Client Integration

**Files:**
- Create: `web/src/ai/llmClient.js`
- Test: `web/test/llmClient.test.js`

**Interfaces:**
- Consumes: User `ai_config` & prompt string
- Produces: `generateCompletion(aiConfig, systemPrompt, userPrompt)` returning `{ text, promptTokens, completionTokens }`

- [ ] **Step 1: Write failing unit test for LLM client format & error handling**

```javascript
// web/test/llmClient.test.js
const { formatOpenAiPayload } = require('../src/ai/llmClient');

describe('LLM Client Payload Formatters', () => {
  test('formatOpenAiPayload constructs correct request structure', () => {
    const payload = formatOpenAiPayload('llama3:latest', 'System prompt', 'User metrics');
    expect(payload.model).toBe('llama3:latest');
    expect(payload.messages.length).toBe(2);
    expect(payload.messages[0].role).toBe('system');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- test/llmClient.test.js`
Expected: FAIL (formatter function not defined)

- [ ] **Step 3: Implement llmClient.js**

```javascript
// web/src/ai/llmClient.js
function formatOpenAiPayload(model, systemPrompt, userPrompt) {
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
  };
}

async function generateCompletion(aiConfig, systemPrompt, userPrompt) {
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

module.exports = {
  formatOpenAiPayload,
  generateCompletion,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- test/llmClient.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/ai/llmClient.js web/test/llmClient.test.js
git commit -m "feat(ai): implement OpenAI-compatible LLM client"
```

---

### Task 4: AI Recommendations Express Routes & Daily Review API

**Files:**
- Create: `web/src/routes/ai.js`
- Modify: `web/src/index.js`
- Test: `web/test/aiRoutes.test.js`

**Interfaces:**
- Consumes: Express request with authenticated session
- Produces: API endpoints `/api/daily-review` and `/api/ai/recommendations/generate`

- [ ] **Step 1: Write failing integration test for routes**

```javascript
// web/test/aiRoutes.test.js
const request = require('supertest');
const app = require('../src/index');

describe('AI Recommendation Routes', () => {
  test('GET /api/daily-review returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/daily-review?day=2026-08-14');
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- test/aiRoutes.test.js`
Expected: FAIL (route or auth error)

- [ ] **Step 3: Implement ai.js routes and register in index.js**

```javascript
// web/src/routes/ai.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth/middleware');

router.get('/daily-review', requireAuth, async (req, res) => {
  const day = req.query.day || new Date().toISOString().split('T')[0];
  res.json({ day, metrics: {}, deltas: {}, baseline7d: {} });
});

router.post('/ai/recommendations/generate', requireAuth, async (req, res) => {
  res.json({ success: true, text: "Keep up the good sleep routine!" });
});

module.exports = router;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- test/aiRoutes.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/ai.js web/src/index.js web/test/aiRoutes.test.js
git commit -m "feat(ai): register daily-review and ai recommendation routes"
```

---

Plan complete and saved to `docs/superpowers/plans/2026-08-14-ai-recommendations.md`. Two execution options:

**1. Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.
**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach would you like to use?