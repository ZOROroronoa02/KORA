-- Bind new order idempotency keys to the accepted request payload.
-- Existing orders remain NULL to preserve safe retries from before this migration.
-- Reversal: ALTER TABLE public.orders DROP COLUMN "idempotencyPayloadHash";
ALTER TABLE "public"."orders" ADD COLUMN "idempotencyPayloadHash" TEXT;
