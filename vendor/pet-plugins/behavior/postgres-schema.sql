CREATE SCHEMA IF NOT EXISTS pet_companion;
CREATE TABLE IF NOT EXISTS pet_companion.schema_version (
  version integer PRIMARY KEY, installed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pet_companion.schema_version(version) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS pet_companion.snapshots (
  namespace text PRIMARY KEY,
  revision bigint NOT NULL,
  checksum text NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pet_companion.records (
  namespace text NOT NULL REFERENCES pet_companion.snapshots(namespace) ON DELETE CASCADE,
  pet_id text NOT NULL,
  kind text NOT NULL,
  id text NOT NULL,
  body text NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload jsonb NOT NULL,
  search_vector tsvector NOT NULL,
  PRIMARY KEY(namespace, pet_id, kind, id)
);
CREATE INDEX IF NOT EXISTS pet_records_search ON pet_companion.records USING gin(search_vector);
CREATE INDEX IF NOT EXISTS pet_records_scope ON pet_companion.records(namespace, pet_id, kind) WHERE NOT deleted;
