ALTER TABLE "shop_orders"
ADD COLUMN "qrTrackingToken" TEXT,
ADD COLUMN "qrScanCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "qrLastScannedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "shop_orders_qrTrackingToken_key"
ON "shop_orders"("qrTrackingToken");
