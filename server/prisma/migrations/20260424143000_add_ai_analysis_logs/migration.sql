-- CreateTable
CREATE TABLE "AiAnalysisLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT,
    "hotspotId" TEXT,
    "source" TEXT,
    "keywordText" TEXT,
    "title" TEXT,
    "url" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'unknown',
    "status" TEXT NOT NULL DEFAULT 'success',
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "elapsedMs" INTEGER NOT NULL DEFAULT 0,
    "relevance" INTEGER,
    "importance" TEXT,
    "reason" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "AiAnalysisLog_createdAt_idx" ON "AiAnalysisLog"("createdAt");

-- CreateIndex
CREATE INDEX "AiAnalysisLog_status_createdAt_idx" ON "AiAnalysisLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AiAnalysisLog_provider_createdAt_idx" ON "AiAnalysisLog"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "AiAnalysisLog_runId_idx" ON "AiAnalysisLog"("runId");

-- CreateIndex
CREATE INDEX "AiAnalysisLog_hotspotId_idx" ON "AiAnalysisLog"("hotspotId");
