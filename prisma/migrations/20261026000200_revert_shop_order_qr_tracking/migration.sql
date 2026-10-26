DROP INDEX IF EXISTS "shop_orders_qrTrackingToken_key";

ALTER TABLE "shop_orders"
DROP COLUMN IF EXISTS "qrTrackingToken",
DROP COLUMN IF EXISTS "qrScanCount",
DROP COLUMN IF EXISTS "qrLastScannedAt";
