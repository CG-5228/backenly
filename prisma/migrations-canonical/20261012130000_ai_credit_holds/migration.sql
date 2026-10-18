-- AI credit holds: one row per customer-paid model call, holding its worst
-- case against the account's AI credits before it is sent, then what it used
-- until its turn is charged (lib/entitlements/credit-holds.ts). Parallel calls
-- can no longer pass the read-only credit gate together and overshoot the cap.
--
-- Additive: one new table, no existing row or column touched, so the release
-- that predates this migration runs unchanged against it.

-- CreateTable
CREATE TABLE "ai_credit_holds" (
    "id" TEXT NOT NULL,
    "billingAccountId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "usedTokens" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "turnScoped" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "ai_credit_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_credit_holds_billingAccountId_month_status_idx" ON "ai_credit_holds"("billingAccountId", "month", "status");
