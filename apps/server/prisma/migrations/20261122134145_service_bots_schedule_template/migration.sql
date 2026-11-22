-- CreateTable
CREATE TABLE "ChannelLinkRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "guildId" TEXT,
    "guildName" TEXT,
    "channelId" TEXT,
    "error" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelLinkRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppState" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_NotificationChannel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" JSONB NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastError" TEXT,
    "lastErrorAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NotificationChannel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_NotificationChannel" ("createdAt", "id", "lastError", "lastErrorAt", "lastSuccessAt", "name", "status", "type", "updatedAt", "userId") SELECT "createdAt", "id", "lastError", "lastErrorAt", "lastSuccessAt", "name", "status", "type", "updatedAt", "userId" FROM "NotificationChannel";
DROP TABLE "NotificationChannel";
ALTER TABLE "new_NotificationChannel" RENAME TO "NotificationChannel";
CREATE INDEX "NotificationChannel_userId_idx" ON "NotificationChannel"("userId");
CREATE TABLE "new_SubscriptionRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "eventTypes" JSONB NOT NULL,
    "minSeverity" TEXT,
    "projectIds" JSONB NOT NULL,
    "schedule" JSONB NOT NULL,
    "template" TEXT,
    "lastDigestAt" DATETIME,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SubscriptionRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SubscriptionRule" ("createdAt", "enabled", "eventTypes", "id", "kind", "minSeverity", "name", "projectIds", "updatedAt", "userId") SELECT "createdAt", "enabled", "eventTypes", "id", "kind", "minSeverity", "name", "projectIds", "updatedAt", "userId" FROM "SubscriptionRule";
DROP TABLE "SubscriptionRule";
ALTER TABLE "new_SubscriptionRule" RENAME TO "SubscriptionRule";
CREATE INDEX "SubscriptionRule_userId_idx" ON "SubscriptionRule"("userId");
CREATE TABLE "new_UserSettings" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Seoul',
    "interestMatchMode" TEXT NOT NULL DEFAULT 'ALL_GROUPS',
    "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quietStartMinute" INTEGER NOT NULL DEFAULT 1320,
    "quietEndMinute" INTEGER NOT NULL DEFAULT 480,
    "urgentBypassQuiet" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_UserSettings" ("interestMatchMode", "quietEndMinute", "quietHoursEnabled", "quietStartMinute", "timezone", "updatedAt", "urgentBypassQuiet", "userId") SELECT "interestMatchMode", "quietEndMinute", "quietHoursEnabled", "quietStartMinute", "timezone", "updatedAt", "urgentBypassQuiet", "userId" FROM "UserSettings";
DROP TABLE "UserSettings";
ALTER TABLE "new_UserSettings" RENAME TO "UserSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ChannelLinkRequest_codeHash_key" ON "ChannelLinkRequest"("codeHash");

-- CreateIndex
CREATE INDEX "ChannelLinkRequest_userId_createdAt_idx" ON "ChannelLinkRequest"("userId", "createdAt");

