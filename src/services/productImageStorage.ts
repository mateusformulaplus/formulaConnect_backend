import { randomUUID } from 'node:crypto';
import { env } from '../config/env.ts';

const IMAGE_DATA_URI_PATTERN = /^data:image\/(jpeg|png|webp|gif|avif);base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_IMAGE_BYTES = 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export class ProductImageStorageError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
    this.name = 'ProductImageStorageError';
  }
}

export function isImageDataUri(image: string): boolean {
  return IMAGE_DATA_URI_PATTERN.test(image);
}

export async function uploadProductImage(image: string): Promise<string> {
  const match = IMAGE_DATA_URI_PATTERN.exec(image);
  if (!match) return image;

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new ProductImageStorageError(
      'Armazenamento de imagens não configurado. Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no backend.',
      503,
    );
  }

  const [, subtype, base64Data] = match;
  const contentType = subtype === 'jpeg' ? 'image/jpeg' : `image/${subtype}`;
  const imageBuffer = Buffer.from(base64Data, 'base64');
  if (imageBuffer.length === 0 || imageBuffer.length > MAX_IMAGE_BYTES) {
    throw new ProductImageStorageError('A imagem deve ter no máximo 1 MB.', 400);
  }

  const objectPath = `products/${randomUUID()}.${IMAGE_EXTENSIONS[contentType]}`;
  const storageUrl = new URL(
    `/storage/v1/object/img/${objectPath.split('/').map(encodeURIComponent).join('/')}`,
    env.SUPABASE_URL,
  );

  let response: Response;
  try {
    response = await fetch(storageUrl, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': contentType,
        'x-upsert': 'false',
      },
      body: imageBuffer,
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    console.error('Falha de rede ao enviar imagem ao Supabase Storage:', error);
    throw new ProductImageStorageError('Não foi possível enviar a imagem ao armazenamento.');
  }

  if (!response.ok) {
    const details = await response.text();
    console.error('Supabase Storage rejeitou o upload da imagem:', response.status, details);
    throw new ProductImageStorageError('O armazenamento recusou o envio da imagem.');
  }

  return new URL(
    `/storage/v1/object/public/img/${objectPath.split('/').map(encodeURIComponent).join('/')}`,
    env.SUPABASE_URL,
  ).toString();
}

export async function uploadProductImages(images: string[]): Promise<string[]> {
  const uniqueImages = [...new Set(images.map((image) => image.trim()).filter(Boolean))];
  return Promise.all(uniqueImages.map(uploadProductImage));
}
