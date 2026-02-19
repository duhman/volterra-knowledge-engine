-- Ampeco Changelog Monitor Tables
-- Migrated from self-hosted to cloud

CREATE TABLE IF NOT EXISTS public.ampeco_changelog_state (
  id integer PRIMARY KEY DEFAULT 1,
  last_seen_version text,
  last_notified_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS public.ampeco_changelog_notifications (
  id serial PRIMARY KEY,
  version text NOT NULL,
  notified_at timestamptz DEFAULT now(),
  slack_response jsonb
);

-- Insert initial state (migrated from self-hosted)
INSERT INTO public.ampeco_changelog_state (id, last_seen_version, last_notified_at, last_checked_at, created_at)
VALUES (1, '31150', '2025-12-22 22:29:18.752+00', '2025-12-22 22:29:18.264+00', '2025-12-22 17:12:00.511095+00')
ON CONFLICT (id) DO NOTHING;

-- RLS (disabled for now as this is a system table)
ALTER TABLE public.ampeco_changelog_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ampeco_changelog_notifications ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role full access on ampeco_changelog_state" ON public.ampeco_changelog_state
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on ampeco_changelog_notifications" ON public.ampeco_changelog_notifications
  FOR ALL USING (true) WITH CHECK (true);
