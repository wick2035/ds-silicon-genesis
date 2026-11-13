-- Separate from the original pet_companion schema. No original objects are changed.
CREATE SCHEMA IF NOT EXISTS silicon_genesis;
CREATE TABLE IF NOT EXISTS silicon_genesis.schema_version (
  version integer PRIMARY KEY, installed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO silicon_genesis.schema_version(version) VALUES (1) ON CONFLICT DO NOTHING;
-- One envelope is authoritative for the legacy, body, and cognition domains.
CREATE TABLE IF NOT EXISTS silicon_genesis.life_state (
  pet_id text PRIMARY KEY,
  version bigint NOT NULL CHECK (version >= 0),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payload->>'petId' = pet_id),
  CHECK ((payload->>'version')::bigint = version),
  CHECK (jsonb_typeof(payload->'legacy') = 'object'),
  CHECK (jsonb_typeof(payload->'humanity') = 'object'),
  CHECK (jsonb_typeof(payload->'life') = 'object')
);
-- Immutable migration material. It is deliberately not interpreted as a new
-- active state until the legacy stores have an audited mapping and cutover.
CREATE TABLE IF NOT EXISTS silicon_genesis.legacy_import (
  source_key text PRIMARY KEY,
  source_revision bigint NOT NULL,
  source_checksum text NOT NULL,
  snapshot jsonb NOT NULL,
  records jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS silicon_genesis.legacy_document (
  source_key text NOT NULL REFERENCES silicon_genesis.legacy_import(source_key),
  name text NOT NULL,
  content text NOT NULL,
  PRIMARY KEY(source_key, name)
);
CREATE TABLE IF NOT EXISTS silicon_genesis.outbox (
  action_id text PRIMARY KEY,
  pet_id text NOT NULL REFERENCES silicon_genesis.life_state(pet_id),
  action_type text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','dispatched','completed','failed','cancelled','unknown')),
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS silicon_genesis_outbox_pending ON silicon_genesis.outbox(created_at) WHERE state = 'pending';
-- Queue bookkeeping, not a second copy of pet state.
CREATE TABLE IF NOT EXISTS silicon_genesis.wake_state (
  pet_id text PRIMARY KEY REFERENCES silicon_genesis.life_state(pet_id),
  processed_count bigint NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  next_wake_at timestamptz NOT NULL DEFAULT 'epoch',
  lease_token text,
  lease_until timestamptz,
  claimed_count bigint,
  CHECK ((lease_token IS NULL AND lease_until IS NULL AND claimed_count IS NULL) OR
         (lease_token IS NOT NULL AND lease_until IS NOT NULL AND claimed_count IS NOT NULL))
);
