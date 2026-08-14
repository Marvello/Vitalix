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
