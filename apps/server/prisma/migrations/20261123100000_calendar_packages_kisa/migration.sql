-- AlterTable
ALTER TABLE "Finding" ADD COLUMN "plannedFixAt" DATETIME;

-- CreateTable
CREATE TABLE "PublicNotice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publishedAt" DATETIME NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "PublicNotice_publishedAt_idx" ON "PublicNotice"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PublicNotice_source_externalId_key" ON "PublicNotice"("source", "externalId");

