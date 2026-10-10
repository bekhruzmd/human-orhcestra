-- Recording sessions for replay support.
-- Designed for append-only writes during an active session and immutable reads for replay.

CREATE TABLE IF NOT EXISTS recording_sessions (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  ended_reason text,
  mode text NOT NULL DEFAULT 'live',
  stage_instance_id text,
  song_id text,
  difficulty text,
  imported_song_hash text,
  protocol_version text,
  engine_version text,
  transport_start jsonb NOT NULL,
  transport_end jsonb,
  players jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS recording_events (
  recording_id uuid NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  server_ms double precision NOT NULL,
  step integer,
  event_type text NOT NULL,
  pid text NOT NULL,
  role text,
  payload jsonb NOT NULL,
  PRIMARY KEY (recording_id, seq)
);

CREATE INDEX IF NOT EXISTS recording_events_recording_step_idx
  ON recording_events (recording_id, step, seq);

CREATE INDEX IF NOT EXISTS recording_sessions_started_idx
  ON recording_sessions (started_at DESC);
