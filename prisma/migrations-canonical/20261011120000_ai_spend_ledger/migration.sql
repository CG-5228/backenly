-- AI spend ledger: model spend is reserved before each call and settled after
-- it, against monthly limits (lib/ai/llm/spend.ts).
--
-- Additive: two new tables, no existing row or column touched, so the release
-- that predates this migration runs unchanged against it.

-- CreateTable
CREATE TABLE "ai_spend_periods" (
    "month" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "reservedUsd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "settledUsd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "unknownUsd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_spend_periods_pkey" PRIMARY KEY ("month","scope")
);

-- CreateTable
CREATE TABLE "ai_spend_holds" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "scopes" TEXT[],
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "amountUsd" DECIMAL(14,6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "chargedUsd" DECIMAL(14,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "ai_spend_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_spend_holds_status_expiresAt_idx" ON "ai_spend_holds"("status", "expiresAt");
