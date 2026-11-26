CREATE FUNCTION public.kora_reject_payment_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Keep related tenant/bill/shift cleanup possible while rejecting direct
  -- application edits or deletes of captured payment records.
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Payments are append-only; record a reversal instead' USING ERRCODE = '23514', CONSTRAINT = 'payments_append_only';
END;
$$;

CREATE TRIGGER "kora_payments_append_only"
  BEFORE UPDATE OR DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.kora_reject_payment_mutation();

-- Down migration: DROP TRIGGER "kora_payments_append_only" ON public.payments; DROP FUNCTION public.kora_reject_payment_mutation();
