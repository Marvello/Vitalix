-- 021_insight_feedback: thumbs up (1) / down (-1) on a daily AI insight; NULL = no vote.
ALTER TABLE ai_recommendations ADD feedback smallint CHECK (feedback IN (-1, 1)), ADD feedback_at timestamptz;
