-- Invoice counters are allocated per outlet and Indian financial year.
ALTER TABLE "outlets" ADD COLUMN "invoiceFinancialYear" TEXT;

-- Down migration: ALTER TABLE "outlets" DROP COLUMN "invoiceFinancialYear";
