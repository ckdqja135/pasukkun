-- CreateTable
CREATE TABLE "ProjectRepoSource" (
    "projectId" TEXT NOT NULL PRIMARY KEY,
    "installationId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "lockfilePath" TEXT NOT NULL,
    "lockfileSha" TEXT,
    "commitSha" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "error" TEXT,
    "autoTech" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" DATETIME,
    "lastChangedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectRepoSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GithubLinkRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "repos" JSONB,
    "error" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GithubLinkRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ProjectSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "inputType" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'UPLOAD',
    "lockfileFormat" TEXT,
    "sourceRef" TEXT,
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
INSERT INTO "new_ProjectSnapshot" ("createdAt", "fileName", "fileSha256", "id", "inputType", "isCurrent", "lockfileVersion", "packageCount", "projectConfig", "projectId", "scannableCount", "seq", "warnings") SELECT "createdAt", "fileName", "fileSha256", "id", "inputType", "isCurrent", "lockfileVersion", "packageCount", "projectConfig", "projectId", "scannableCount", "seq", "warnings" FROM "ProjectSnapshot";
DROP TABLE "ProjectSnapshot";
ALTER TABLE "new_ProjectSnapshot" RENAME TO "ProjectSnapshot";
CREATE INDEX "ProjectSnapshot_projectId_isCurrent_idx" ON "ProjectSnapshot"("projectId", "isCurrent");
CREATE UNIQUE INDEX "ProjectSnapshot_projectId_seq_key" ON "ProjectSnapshot"("projectId", "seq");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ProjectRepoSource_lastCheckedAt_idx" ON "ProjectRepoSource"("lastCheckedAt");

-- CreateIndex
CREATE INDEX "ProjectRepoSource_repoId_idx" ON "ProjectRepoSource"("repoId");

-- CreateIndex
CREATE UNIQUE INDEX "GithubLinkRequest_stateHash_key" ON "GithubLinkRequest"("stateHash");

-- CreateIndex
CREATE INDEX "GithubLinkRequest_userId_createdAt_idx" ON "GithubLinkRequest"("userId", "createdAt");


-- 기존 lockfile 스냅샷은 모두 package-lock.json 이었다
UPDATE "ProjectSnapshot" SET "lockfileFormat" = 'NPM' WHERE "inputType" = 'LOCKFILE';
