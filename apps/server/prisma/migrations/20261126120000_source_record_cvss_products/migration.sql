-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_VulnerabilityCvss" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vulnerabilityId" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "vector" TEXT NOT NULL,
    "score" REAL,
    CONSTRAINT "VulnerabilityCvss_vulnerabilityId_fkey" FOREIGN KEY ("vulnerabilityId") REFERENCES "Vulnerability" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VulnerabilityCvss_sourceRecordId_fkey" FOREIGN KEY ("sourceRecordId") REFERENCES "SourceRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- 기존 점수는 같은 출처 종류에서 마지막으로 저장된 레코드가 쓴 것이다 (이전에는 저장할 때마다 출처 종류 단위로 지우고 다시 썼다).
INSERT INTO "new_VulnerabilityCvss" ("id", "vulnerabilityId", "sourceRecordId", "source", "version", "vector", "score")
SELECT c."id", c."vulnerabilityId", r."id", c."source", c."version", c."vector", c."score"
FROM "VulnerabilityCvss" c
JOIN "SourceRecord" r ON r."id" = (
    SELECT sr."id" FROM "SourceRecord" sr
    WHERE sr."vulnerabilityId" = c."vulnerabilityId"
      AND sr."source" = CASE WHEN instr(c."source", ':') > 0 THEN substr(c."source", 1, instr(c."source", ':') - 1) ELSE c."source" END
    ORDER BY sr."fetchedAt" DESC, sr."id" DESC
    LIMIT 1
);
DROP TABLE "VulnerabilityCvss";
ALTER TABLE "new_VulnerabilityCvss" RENAME TO "VulnerabilityCvss";
CREATE INDEX "VulnerabilityCvss_vulnerabilityId_idx" ON "VulnerabilityCvss"("vulnerabilityId");
CREATE UNIQUE INDEX "VulnerabilityCvss_sourceRecordId_source_version_key" ON "VulnerabilityCvss"("sourceRecordId", "source", "version");
CREATE TABLE "new_VulnerabilityProduct" (
    "vulnerabilityId" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "product" TEXT NOT NULL,

    PRIMARY KEY ("sourceRecordId", "vendor", "product"),
    CONSTRAINT "VulnerabilityProduct_vulnerabilityId_fkey" FOREIGN KEY ("vulnerabilityId") REFERENCES "Vulnerability" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VulnerabilityProduct_sourceRecordId_fkey" FOREIGN KEY ("sourceRecordId") REFERENCES "SourceRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- CPE 제품은 NVD 레코드만 준다. 마지막으로 저장된 NVD 레코드에 연결한다.
INSERT INTO "new_VulnerabilityProduct" ("vulnerabilityId", "sourceRecordId", "vendor", "product")
SELECT p."vulnerabilityId", r."id", p."vendor", p."product"
FROM "VulnerabilityProduct" p
JOIN "SourceRecord" r ON r."id" = (
    SELECT sr."id" FROM "SourceRecord" sr
    WHERE sr."vulnerabilityId" = p."vulnerabilityId" AND sr."source" = 'NVD'
    ORDER BY sr."fetchedAt" DESC, sr."id" DESC
    LIMIT 1
);
DROP TABLE "VulnerabilityProduct";
ALTER TABLE "new_VulnerabilityProduct" RENAME TO "VulnerabilityProduct";
CREATE INDEX "VulnerabilityProduct_vulnerabilityId_idx" ON "VulnerabilityProduct"("vulnerabilityId");
CREATE INDEX "VulnerabilityProduct_vendor_product_idx" ON "VulnerabilityProduct"("vendor", "product");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

