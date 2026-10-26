-- CreateTable
CREATE TABLE "shop_configs" (
    "id" TEXT NOT NULL,
    "businessName" TEXT NOT NULL DEFAULT 'Fórmula Plus',
    "whatsapp" TEXT NOT NULL,
    "defaultMessage" TEXT NOT NULL DEFAULT 'Olá! Gostaria de saber mais sobre os produtos da Fórmula Plus.',
    "qrCodeNumber" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_products" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subtitle" TEXT,
    "description" TEXT,
    "price" TEXT NOT NULL,
    "imageUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_orders" (
    "id" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "email" TEXT,
    "whatsapp" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "productId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "qrCodeNumber" TEXT,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shop_configs_qrCodeNumber_key" ON "shop_configs"("qrCodeNumber");

-- CreateIndex
CREATE INDEX "shop_products_active_sortOrder_idx" ON "shop_products"("active", "sortOrder");

-- CreateIndex
CREATE INDEX "shop_orders_createdAt_idx" ON "shop_orders"("createdAt");
