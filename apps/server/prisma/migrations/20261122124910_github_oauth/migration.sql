/*
  Warnings:

  - You are about to drop the column `authorEmail` on the `FindingReview` table. All the data in the column will be lost.
  - You are about to drop the column `authorEmail` on the `FindingStatusHistory` table. All the data in the column will be lost.
  - You are about to drop the column `email` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `passwordHash` on the `User` table. All the data in the column will be lost.
  - Added the required column `authorName` to the `FindingReview` table without a default value. This is not possible if the table is not empty.
  - Added the required column `authorName` to the `FindingStatusHistory` table without a default value. This is not possible if the table is not empty.
  - Added the required column `githubId` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `githubLogin` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FindingReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "findingId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "checks" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "basedOnSnapshotId" TEXT,
    "basedOnRangeHash" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FindingReview_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_FindingReview" ("authorId", "basedOnRangeHash", "basedOnSnapshotId", "checks", "createdAt", "findingId", "id", "rationale", "verdict") SELECT "authorId", "basedOnRangeHash", "basedOnSnapshotId", "checks", "createdAt", "findingId", "id", "rationale", "verdict" FROM "FindingReview";
DROP TABLE "FindingReview";
ALTER TABLE "new_FindingReview" RENAME TO "FindingReview";
CREATE INDEX "FindingReview_findingId_createdAt_idx" ON "FindingReview"("findingId", "createdAt");
CREATE TABLE "new_FindingStatusHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "findingId" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FindingStatusHistory_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_FindingStatusHistory" ("authorId", "createdAt", "findingId", "fromStatus", "id", "reason", "toStatus") SELECT "authorId", "createdAt", "findingId", "fromStatus", "id", "reason", "toStatus" FROM "FindingStatusHistory";
DROP TABLE "FindingStatusHistory";
ALTER TABLE "new_FindingStatusHistory" RENAME TO "FindingStatusHistory";
CREATE INDEX "FindingStatusHistory_findingId_createdAt_idx" ON "FindingStatusHistory"("findingId", "createdAt");
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "githubId" TEXT NOT NULL,
    "githubLogin" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_User" ("createdAt", "id") SELECT "createdAt", "id" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_githubId_key" ON "User"("githubId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
