-- ============================================================================
-- DELIVERY BODIES — a regional project's webhook and trigger payloads, per region
-- ============================================================================
-- Install with:  bash scripts/install-sql.sh scripts/sql/delivery-bodies.sql
--
-- A webhook or trigger delivery carries the row that fired it, and records what
-- the receiver answered. For a project outside the home region both stay in
-- that region (lib/webhooks/delivery-bodies.ts): the platform database keeps
-- the delivery's row, with a NULL payload, for scheduling, listing and alerts,
-- and this table keeps the body, under the same id, for 30 days.
--
-- Idempotent. Run as the installer, after scripts/postgrest-install.sh (which
-- defines public.backenly_app_role()). Not for the home database: a home
-- project's bodies stay on the platform rows (webhook_logs,
-- trigger_delivery_logs), where Prisma owns them.
--
-- Ownership stays with the installer. The application role writes, reads and
-- prunes bodies; nothing else may read them.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.delivery_bodies (
    "id"           TEXT        NOT NULL,
    "kind"         TEXT        NOT NULL,
    "projectId"    TEXT        NOT NULL,
    "payload"      JSONB       NOT NULL,
    "responseBody" TEXT,
    "error"        TEXT,
    "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "delivery_bodies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "delivery_bodies_kind_check" CHECK ("kind" IN ('webhook', 'trigger'))
);

CREATE INDEX IF NOT EXISTS "delivery_bodies_projectId_createdAt_idx"
    ON public.delivery_bodies ("projectId", "createdAt");

CREATE INDEX IF NOT EXISTS "delivery_bodies_createdAt_idx"
    ON public.delivery_bodies ("createdAt");

-- Nobody but the installer and the application role.
REVOKE ALL ON public.delivery_bodies FROM PUBLIC;

DO $$
BEGIN
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON public.delivery_bodies TO %I',
    public.backenly_app_role()
  );
END $$;
