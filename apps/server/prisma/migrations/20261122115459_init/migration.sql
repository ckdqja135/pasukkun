-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Seoul',
    "interestMatchMode" TEXT NOT NULL DEFAULT 'ALL_GROUPS',
    "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quietStartMinute" INTEGER NOT NULL DEFAULT 1320,
    "quietEndMinute" INTEGER NOT NULL DEFAULT 480,
    "urgentBypassQuiet" BOOLEAN NOT NULL DEFAULT false,
    "digestMinute" INTEGER NOT NULL DEFAULT 540,
    "lastDigestDate" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Technology" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "aliases" JSONB NOT NULL,
    "scanSupport" TEXT NOT NULL DEFAULT 'FEED_ONLY',
    "sortOrder" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "TechnologyMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "technologyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ecosystem" TEXT,
    "pattern" TEXT,
    CONSTRAINT "TechnologyMapping_technologyId_fkey" FOREIGN KEY ("technologyId") REFERENCES "Technology" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserTechnologyInterest" (
    "userId" TEXT NOT NULL,
    "technologyId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("userId", "technologyId"),
    CONSTRAINT "UserTechnologyInterest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserTechnologyInterest_technologyId_fkey" FOREIGN KEY ("technologyId") REFERENCES "Technology" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Vulnerability" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "publishedAt" DATETIME,
    "modifiedAt" DATETIME,
    "withdrawnAt" DATETIME,
    "severity" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "severityRank" INTEGER NOT NULL DEFAULT 0,
    "cvssScore" REAL,
    "cvssVersion" TEXT,
    "cvssVector" TEXT,
    "cvssSource" TEXT,
    "kevAddedAt" DATETIME,
    "kevDueDate" DATETIME,
    "kevRansomware" TEXT,
    "epssScore" REAL,
    "epssPercentile" REAL,
    "epssDate" TEXT,
    "patchStatus" TEXT NOT NULL DEFAULT 'UNCONFIRMED',
    "classified" BOOLEAN NOT NULL DEFAULT false,
    "searchText" TEXT NOT NULL DEFAULT '',
    "meaningfulHash" TEXT NOT NULL DEFAULT '',
    "rangeHash" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "VulnerabilityIdentifier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vulnerabilityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "VulnerabilityIdentifier_vulnerabilityId_fkey" FOREIGN KEY ("vulnerabilityId") REFERENCES "Vulnerability" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SourceRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "vulnerabilityId" TEXT NOT NULL,
    "raw" BLOB NOT NULL,
    "rawHash" TEXT NOT NULL,
    "sourceModifiedAt" DATETIME,
    "withdrawn" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL DEFAULT '',
    "details" TEXT NOT NULL DEFAULT '',
    "references" JSONB NOT NULL,
    "publishedAt" DATETIME,
    "severityLabel" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "htmlUrl" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SourceRecord_vulnerabilityId_fkey" FOREIGN KEY ("vulnerabilityId") REFERENCES "Vulnerability" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VulnerabilityCvss" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vulnerabilityId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "vector" TEXT NOT NULL,
    "score" REAL,
    CONSTRAINT "VulnerabilityCvss_vulnerabilityId_fkey" FOREIGN KEY ("vulnerabilityId") REFERENCES "Vulnerability" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Package" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ecosystem" TEXT NOT NULL,
    "name" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "AffectedPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vulnerabilityId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "intervals" JSONB NOT NULL,
    "versions" JSONB NOT NULL,
    "unparsed" JSONB NOT NULL,
    "functions" JSONB NOT NULL,
    "rangeHash" TEXT NOT NULL,
    CONSTRAINT "AffectedPackage_vulnerabilityId_fkey" FOREIGN KEY ("vulnerabilityId") REFERENCES "Vulnerability" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AffectedPackage_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AffectedPackage_sourceRecordId_fkey" FOREIGN KEY ("sourceRecordId") REFERENCES "SourceRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VulnerabilityProduct" (
    "vulnerabilityId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "product" TEXT NOT NULL,

    PRIMARY KEY ("vulnerabilityId", "vendor", "product"),
    CONSTRAINT "VulnerabilityProduct_vulnerabilityId_fkey" FOREIGN KEY ("vulnerabilityId") REFERENCES "Vulnerability" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VulnerabilityTechnology" (
    "vulnerabilityId" TEXT NOT NULL,
    "technologyId" TEXT NOT NULL,
    "basis" TEXT NOT NULL,

    PRIMARY KEY ("vulnerabilityId", "technologyId"),
    CONSTRAINT "VulnerabilityTechnology_vulnerabilityId_fkey" FOREIGN KEY ("vulnerabilityId") REFERENCES "Vulnerability" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VulnerabilityTechnology_technologyId_fkey" FOREIGN KEY ("technologyId") REFERENCES "Technology" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VulnerabilityMerge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "survivorId" TEXT NOT NULL,
    "mergedId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "KevEntry" (
    "cve" TEXT NOT NULL PRIMARY KEY,
    "vendorProject" TEXT NOT NULL DEFAULT '',
    "product" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "dateAdded" DATETIME NOT NULL,
    "dueDate" DATETIME,
    "ransomwareUse" TEXT NOT NULL DEFAULT 'Unknown',
    "requiredAction" TEXT NOT NULL DEFAULT '',
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "environments" JSONB NOT NULL,
    "exposure" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "runtime" TEXT NOT NULL DEFAULT '',
    "runtimeVersion" TEXT NOT NULL DEFAULT '',
    "os" TEXT NOT NULL DEFAULT '',
    "distro" TEXT NOT NULL DEFAULT '',
    "arch" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectTechnology" (
    "projectId" TEXT NOT NULL,
    "technologyId" TEXT NOT NULL,

    PRIMARY KEY ("projectId", "technologyId"),
    CONSTRAINT "ProjectTechnology_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectTechnology_technologyId_fkey" FOREIGN KEY ("technologyId") REFERENCES "Technology" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "inputType" TEXT NOT NULL,
    "fileName" TEXT,
    "fileSha256" TEXT,
    "lockfileVersion" INTEGER,
    "warnings" JSONB NOT NULL,
    "projectConfig" JSONB NOT NULL,
    "packageCount" INTEGER NOT NULL DEFAULT 0,
    "scannableCount" INTEGER NOT NULL DEFAULT 0,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SnapshotPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "packageId" TEXT,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "installPath" TEXT NOT NULL,
    "isDirect" BOOLEAN NOT NULL DEFAULT false,
    "isDev" BOOLEAN NOT NULL DEFAULT false,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,
    "dependencyPath" JSONB NOT NULL,
    "refKind" TEXT NOT NULL DEFAULT 'REGISTRY',
    "scannable" BOOLEAN NOT NULL DEFAULT true,
    "unsupportedReason" TEXT,
    CONSTRAINT "SnapshotPackage_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ProjectSnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SnapshotPackage_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScanRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "isInitial" BOOLEAN NOT NULL DEFAULT false,
    "packagesTotal" INTEGER NOT NULL DEFAULT 0,
    "packagesScanned" INTEGER NOT NULL DEFAULT 0,
    "scope" JSONB NOT NULL,
    "sourceFreshness" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "ScanRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ScanRun_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ProjectSnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "vulnerabilityId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "versionMatch" TEXT NOT NULL,
    "exploitCondition" TEXT NOT NULL DEFAULT 'NOT_ANALYZED',
    "priority" TEXT NOT NULL,
    "priorityRank" INTEGER NOT NULL DEFAULT 0,
    "priorityReasons" JSONB NOT NULL,
    "ruleVersion" TEXT NOT NULL DEFAULT '',
    "evidence" JSONB NOT NULL,
    "fixedVersion" TEXT,
    "remediationStatus" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "acceptReason" TEXT,
    "reviewDueAt" DATETIME,
    "needsRecheck" BOOLEAN NOT NULL DEFAULT false,
    "recheckReason" TEXT,
    "resolvedAt" DATETIME,
    "resolution" TEXT,
    "firstSeenScanId" TEXT,
    "lastSeenScanId" TEXT,
    "rangeHash" TEXT NOT NULL DEFAULT '',
    "analyzedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Finding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Finding_vulnerabilityId_fkey" FOREIGN KEY ("vulnerabilityId") REFERENCES "Vulnerability" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Finding_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FindingReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "findingId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorEmail" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "checks" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "basedOnSnapshotId" TEXT,
    "basedOnRangeHash" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FindingReview_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FindingStatusHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "findingId" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorEmail" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FindingStatusHistory_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedConfig" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "configHint" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "lastError" TEXT,
    "lastErrorAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NotificationChannel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SubscriptionRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "eventTypes" JSONB NOT NULL,
    "minSeverity" TEXT,
    "projectIds" JSONB NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'IMMEDIATE',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SubscriptionRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RuleChannel" (
    "ruleId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,

    PRIMARY KEY ("ruleId", "channelId"),
    CONSTRAINT "RuleChannel_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SubscriptionRule" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RuleChannel_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "NotificationChannel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NotificationEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "vulnerabilityId" TEXT,
    "projectId" TEXT,
    "findingId" TEXT,
    "payload" JSONB NOT NULL,
    "changeFingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "relayedAt" DATETIME,
    CONSTRAINT "NotificationEvent_vulnerabilityId_fkey" FOREIGN KEY ("vulnerabilityId") REFERENCES "Vulnerability" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NotificationEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NotificationEvent_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    CONSTRAINT "NotificationDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "NotificationEvent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "NotificationDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NotificationDelivery_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SubscriptionRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "NotificationDelivery_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "NotificationChannel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IngestionSource" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "intervalMinutes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEVER_RUN',
    "lastAttemptAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "backfillDone" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "IngestionCheckpoint" (
    "source" TEXT NOT NULL,
    "stream" TEXT NOT NULL,
    "cursor" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("source", "stream"),
    CONSTRAINT "IngestionCheckpoint_source_fkey" FOREIGN KEY ("source") REFERENCES "IngestionSource" ("key") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IngestionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "windowFrom" DATETIME,
    "windowTo" DATETIME,
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "upserted" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "IngestionRun_source_fkey" FOREIGN KEY ("source") REFERENCES "IngestionSource" ("key") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "dedupeKey" TEXT,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lockedUntil" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Technology_slug_key" ON "Technology"("slug");

-- CreateIndex
CREATE INDEX "Technology_group_idx" ON "Technology"("group");

-- CreateIndex
CREATE INDEX "TechnologyMapping_kind_ecosystem_pattern_idx" ON "TechnologyMapping"("kind", "ecosystem", "pattern");

-- CreateIndex
CREATE UNIQUE INDEX "TechnologyMapping_technologyId_kind_ecosystem_pattern_key" ON "TechnologyMapping"("technologyId", "kind", "ecosystem", "pattern");

-- CreateIndex
CREATE INDEX "Vulnerability_publishedAt_idx" ON "Vulnerability"("publishedAt");

-- CreateIndex
CREATE INDEX "Vulnerability_modifiedAt_idx" ON "Vulnerability"("modifiedAt");

-- CreateIndex
CREATE INDEX "Vulnerability_severityRank_idx" ON "Vulnerability"("severityRank");

-- CreateIndex
CREATE INDEX "Vulnerability_kevAddedAt_idx" ON "Vulnerability"("kevAddedAt");

-- CreateIndex
CREATE INDEX "Vulnerability_classified_idx" ON "Vulnerability"("classified");

-- CreateIndex
CREATE UNIQUE INDEX "VulnerabilityIdentifier_value_key" ON "VulnerabilityIdentifier"("value");

-- CreateIndex
CREATE INDEX "VulnerabilityIdentifier_vulnerabilityId_idx" ON "VulnerabilityIdentifier"("vulnerabilityId");

-- CreateIndex
CREATE INDEX "SourceRecord_vulnerabilityId_idx" ON "SourceRecord"("vulnerabilityId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRecord_source_sourceId_key" ON "SourceRecord"("source", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "VulnerabilityCvss_vulnerabilityId_source_version_key" ON "VulnerabilityCvss"("vulnerabilityId", "source", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Package_ecosystem_name_key" ON "Package"("ecosystem", "name");

-- CreateIndex
CREATE INDEX "AffectedPackage_packageId_idx" ON "AffectedPackage"("packageId");

-- CreateIndex
CREATE INDEX "AffectedPackage_vulnerabilityId_idx" ON "AffectedPackage"("vulnerabilityId");

-- CreateIndex
CREATE UNIQUE INDEX "AffectedPackage_sourceRecordId_packageId_key" ON "AffectedPackage"("sourceRecordId", "packageId");

-- CreateIndex
CREATE INDEX "VulnerabilityProduct_vendor_product_idx" ON "VulnerabilityProduct"("vendor", "product");

-- CreateIndex
CREATE INDEX "VulnerabilityTechnology_technologyId_idx" ON "VulnerabilityTechnology"("technologyId");

-- CreateIndex
CREATE INDEX "Project_userId_idx" ON "Project"("userId");

-- CreateIndex
CREATE INDEX "ProjectSnapshot_projectId_isCurrent_idx" ON "ProjectSnapshot"("projectId", "isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSnapshot_projectId_seq_key" ON "ProjectSnapshot"("projectId", "seq");

-- CreateIndex
CREATE INDEX "SnapshotPackage_snapshotId_idx" ON "SnapshotPackage"("snapshotId");

-- CreateIndex
CREATE INDEX "SnapshotPackage_packageId_version_idx" ON "SnapshotPackage"("packageId", "version");

-- CreateIndex
CREATE INDEX "ScanRun_projectId_createdAt_idx" ON "ScanRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Finding_projectId_resolvedAt_priorityRank_idx" ON "Finding"("projectId", "resolvedAt", "priorityRank");

-- CreateIndex
CREATE INDEX "Finding_vulnerabilityId_idx" ON "Finding"("vulnerabilityId");

-- CreateIndex
CREATE UNIQUE INDEX "Finding_projectId_vulnerabilityId_packageId_version_key" ON "Finding"("projectId", "vulnerabilityId", "packageId", "version");

-- CreateIndex
CREATE INDEX "FindingReview_findingId_createdAt_idx" ON "FindingReview"("findingId", "createdAt");

-- CreateIndex
CREATE INDEX "FindingStatusHistory_findingId_createdAt_idx" ON "FindingStatusHistory"("findingId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationChannel_userId_idx" ON "NotificationChannel"("userId");

-- CreateIndex
CREATE INDEX "SubscriptionRule_userId_idx" ON "SubscriptionRule"("userId");

-- CreateIndex
CREATE INDEX "NotificationEvent_relayedAt_createdAt_idx" ON "NotificationEvent"("relayedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_dedupeKey_key" ON "NotificationDelivery"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_nextAttemptAt_idx" ON "NotificationDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_userId_createdAt_idx" ON "NotificationDelivery"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "IngestionRun_source_startedAt_idx" ON "IngestionRun"("source", "startedAt");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- CreateIndex
CREATE INDEX "Job_dedupeKey_status_idx" ON "Job"("dedupeKey", "status");
