-- Rebuildable projections only. life_state remains the source of truth.
CREATE TABLE IF NOT EXISTS silicon_genesis.memory_index_document (
  pet_id text NOT NULL REFERENCES silicon_genesis.life_state(pet_id),
  document_id text NOT NULL,
  source_version bigint NOT NULL,
  terms text[] NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (pet_id,document_id)
);
CREATE INDEX IF NOT EXISTS memory_index_terms ON silicon_genesis.memory_index_document USING gin(terms);
CREATE TABLE IF NOT EXISTS silicon_genesis.memory_index_status (
  pet_id text PRIMARY KEY REFERENCES silicon_genesis.life_state(pet_id),
  source_version bigint NOT NULL,
  document_count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO silicon_genesis.schema_version(version) VALUES (2) ON CONFLICT DO NOTHING;
-- Vectors and locality buckets are derived from valid canonical records.
CREATE TABLE IF NOT EXISTS silicon_genesis.memory_index_embedding (
  pet_id text NOT NULL REFERENCES silicon_genesis.life_state(pet_id),
  document_id text NOT NULL,
  content_hash text NOT NULL,
  model text NOT NULL,
  embedding real[] NOT NULL,
  buckets text[] NOT NULL,
  PRIMARY KEY (pet_id, document_id)
);
CREATE INDEX IF NOT EXISTS memory_embedding_buckets ON silicon_genesis.memory_index_embedding USING gin(buckets);
INSERT INTO silicon_genesis.schema_version(version) VALUES (3) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS silicon_genesis.memory_index_term_stat (
  pet_id text NOT NULL REFERENCES silicon_genesis.life_state(pet_id),
  term text NOT NULL,
  source_version bigint NOT NULL,
  document_frequency integer NOT NULL,
  total_frequency bigint NOT NULL,
  PRIMARY KEY (pet_id,term)
);
INSERT INTO silicon_genesis.schema_version(version) VALUES (4) ON CONFLICT DO NOTHING;
