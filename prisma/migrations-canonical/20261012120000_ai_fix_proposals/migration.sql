-- AI fix proposals: a repair an AI investigation proposed, bound to the
-- evidence and catalog state it was proposed against, run only on a person's
-- approval of that exact version (lib/autonomy/ai-proposals.ts).
--
-- Additive: one new table, no existing row or column touched, so the release
-- that predates this migration runs unchanged against it.

-- CreateTable
CREATE TABLE "ai_fix_proposals" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "action" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "proposalVersion" TEXT NOT NULL,
    "evidenceFingerprint" TEXT NOT NULL,
    "catalogFingerprint" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "executionId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "outcome" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_fix_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_fix_proposals_projectId_status_idx" ON "ai_fix_proposals"("projectId", "status");

-- CreateIndex
CREATE INDEX "ai_fix_proposals_findingId_idx" ON "ai_fix_proposals"("findingId");

-- AddForeignKey
ALTER TABLE "ai_fix_proposals" ADD CONSTRAINT "ai_fix_proposals_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
