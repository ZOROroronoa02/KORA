CREATE TABLE "payment_reversals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "shiftId" TEXT,
    "createdById" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "reference" TEXT,
    "reason" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_reversals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_reversals_amount_positive" CHECK ("amountPaise" > 0),
    CONSTRAINT "payment_reversals_reason_nonempty" CHECK (length(trim("reason")) >= 3)
);

CREATE INDEX "payment_reversals_tenantId_outletId_recordedAt_idx" ON "payment_reversals"("tenantId", "outletId", "recordedAt");
CREATE INDEX "payment_reversals_paymentId_recordedAt_idx" ON "payment_reversals"("paymentId", "recordedAt");
CREATE INDEX "payment_reversals_shiftId_method_recordedAt_idx" ON "payment_reversals"("shiftId", "method", "recordedAt");

ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_outletId_fkey"
  FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_shiftId_fkey"
  FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION public.kora_assert_payment_reversal_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_tenant text;
  source_outlet text;
  source_method "PaymentMethod";
  actor_tenant text;
  shift_outlet text;
BEGIN
  SELECT b."tenantId", b."outletId", p."method"
    INTO source_tenant, source_outlet, source_method
    FROM public.payments p JOIN public.bills b ON b.id = p."billId"
    WHERE p.id = NEW."paymentId";
  SELECT "tenantId" INTO actor_tenant FROM public.users WHERE id = NEW."createdById";
  IF source_tenant IS DISTINCT FROM NEW."tenantId"
     OR source_outlet IS DISTINCT FROM NEW."outletId"
     OR actor_tenant IS DISTINCT FROM NEW."tenantId"
     OR source_method IS DISTINCT FROM NEW."method" THEN
    RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
  END IF;
  IF NEW."shiftId" IS NOT NULL THEN
    SELECT "outletId" INTO shift_outlet FROM public.shifts WHERE id = NEW."shiftId";
    IF shift_outlet IS DISTINCT FROM NEW."outletId" THEN
      RAISE EXCEPTION 'KORA ownership violation on table %', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'kora_tenant_ownership_guard';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.kora_reject_payment_reversal_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Allow tenant/outlet/payment cascades to clean up a whole tenant, but reject
  -- direct application updates/deletes of financial ledger entries.
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Payment reversals are append-only' USING ERRCODE = '23514', CONSTRAINT = 'payment_reversals_append_only';
END;
$$;

CREATE TRIGGER "kora_payment_reversals_ownership"
  BEFORE INSERT OR UPDATE ON public.payment_reversals
  FOR EACH ROW EXECUTE FUNCTION public.kora_assert_payment_reversal_ownership();
CREATE TRIGGER "kora_payment_reversals_append_only"
  BEFORE UPDATE OR DELETE ON public.payment_reversals
  FOR EACH ROW EXECUTE FUNCTION public.kora_reject_payment_reversal_mutation();

-- Down migration: DROP TABLE "payment_reversals" CASCADE; DROP FUNCTION public.kora_assert_payment_reversal_ownership(); DROP FUNCTION public.kora_reject_payment_reversal_mutation();
