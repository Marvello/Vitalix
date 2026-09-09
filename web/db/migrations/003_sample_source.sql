-- 003_sample_source: dataOrigin package name per sample/exercise (was 1721700000000_sample_source.cjs)
ALTER TABLE samples   ADD COLUMN source text;
ALTER TABLE exercises ADD COLUMN source text;
CREATE INDEX samples_source_index ON samples (source);
