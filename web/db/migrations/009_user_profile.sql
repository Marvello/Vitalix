-- 009_user_profile (was 1722300000000_user_profile.cjs)
ALTER TABLE users ADD COLUMN profile_height_m double precision;
ALTER TABLE users ADD COLUMN bmi_scale text NOT NULL DEFAULT 'standard';
