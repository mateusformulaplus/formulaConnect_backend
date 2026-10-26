import { PrismaClient } from '@prisma/client';
import { isImageDataUri, uploadProductImages } from '../services/productImageStorage.ts';

const prisma = new PrismaClient();

async function migrateProductImages() {
  const products = await prisma.shopProduct.findMany({
    select: { id: true, name: true, imageUrl: true, images: true },
  });
  let migratedCount = 0;

  for (const product of products) {
    const imageInputs = [...new Set([
      ...(product.imageUrl ? [product.imageUrl] : []),
      ...product.images,
    ])];
    if (!imageInputs.some(isImageDataUri)) continue;

    const images = await uploadProductImages(imageInputs);
    const migratedImages = new Map(imageInputs.map((image, index) => [image, images[index]]));
    const migratedImageUrl = product.imageUrl ? migratedImages.get(product.imageUrl) || null : null;
    await prisma.shopProduct.update({
      where: { id: product.id },
      data: {
        images: product.images.map((image) => migratedImages.get(image) || image),
        imageUrl: migratedImageUrl,
      },
    });
    migratedCount += 1;
    console.info(`Imagens migradas: ${product.name}`);
  }

  console.info(`Migração concluída: ${migratedCount} produto(s) atualizado(s).`);
}

migrateProductImages()
  .catch((error: unknown) => {
    console.error('Falha ao migrar imagens dos produtos:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
