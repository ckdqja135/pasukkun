-- CreateTable
CREATE TABLE "Briefing" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL,
    "ruleId" TEXT,
    "ruleName" TEXT NOT NULL,
    "slotAt" DATETIME NOT NULL,
    "fromAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BUILDING',
    "title" TEXT NOT NULL DEFAULT '',
    "headline" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "tone" TEXT NOT NULL DEFAULT 'info',
    "content" JSONB,
    "aiModel" TEXT,
    "aiError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Briefing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Briefing_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SubscriptionRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_NotificationDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT,
    "userId" TEXT NOT NULL,
    "ruleId" TEXT,
    "channelId" TEXT NOT NULL,
    "projectId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'EVENT',
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" DATETIME,
    "lastError" TEXT,
    "lastStatusCode" INTEGER,
    "providerMessageId" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "digestId" TEXT,
    "briefingId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    CONSTRAINT "NotificationDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "NotificationEvent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "NotificationDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NotificationDelivery_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SubscriptionRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "NotificationDelivery_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "NotificationChannel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NotificationDelivery_briefingId_fkey" FOREIGN KEY ("briefingId") REFERENCES "Briefing" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_NotificationDelivery" ("attempts", "channelId", "createdAt", "dedupeKey", "digestId", "eventId", "id", "kind", "lastError", "lastStatusCode", "lockedUntil", "nextAttemptAt", "projectId", "providerMessageId", "ruleId", "sentAt", "status", "title", "userId") SELECT "attempts", "channelId", "createdAt", "dedupeKey", "digestId", "eventId", "id", "kind", "lastError", "lastStatusCode", "lockedUntil", "nextAttemptAt", "projectId", "providerMessageId", "ruleId", "sentAt", "status", "title", "userId" FROM "NotificationDelivery";
DROP TABLE "NotificationDelivery";
ALTER TABLE "new_NotificationDelivery" RENAME TO "NotificationDelivery";
CREATE UNIQUE INDEX "NotificationDelivery_dedupeKey_key" ON "NotificationDelivery"("dedupeKey");
CREATE INDEX "NotificationDelivery_status_nextAttemptAt_idx" ON "NotificationDelivery"("status", "nextAttemptAt");
CREATE INDEX "NotificationDelivery_briefingId_idx" ON "NotificationDelivery"("briefingId");
CREATE INDEX "NotificationDelivery_userId_createdAt_idx" ON "NotificationDelivery"("userId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Briefing_userId_id_idx" ON "Briefing"("userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Briefing_ruleId_slotAt_key" ON "Briefing"("ruleId", "slotAt");

