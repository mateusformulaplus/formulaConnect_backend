import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seed do banco de dados Fórmula Plus Conecta...');

  // 1. Administrador Padrão
  const passwordHash = await bcrypt.hash('admin123', 10);
  const admin = await prisma.adminUser.upsert({
    where: { email: 'admin@formulaplus.com.br' },
    update: {},
    create: {
      name: 'Dr. Lucas Ferreira (Admin Fórmula Plus)',
      email: 'admin@formulaplus.com.br',
      passwordHash,
    },
  });

  console.log(`✅ Administrador cadastrado: ${admin.email}`);

  const shopConfig = await prisma.shopConfig.upsert({
    where: { qrCodeNumber: '123456' },
    update: {},
    create: {
      businessName: 'Fórmula Plus',
      whatsapp: '5511999999999',
      defaultMessage: 'Olá! Gostaria de saber mais sobre os produtos da Fórmula Plus.',
      qrCodeNumber: '123456',
    },
  });

  const products = [
    {
      name: 'Sérum Vitamina C',
      subtitle: 'Brilho e luminosidade',
      description: 'Sérum antioxidante para pele com aparência revitalizada.',
      price: 'R$ 149,00',
      sortOrder: 1,
      images: [
        'https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?auto=format&fit=crop&w=900&q=80',
        'https://images.unsplash.com/photo-1556228578-8c89e6adf883?auto=format&fit=crop&w=900&q=80',
      ],
    },
    {
      name: 'Sérum Hialurônico',
      subtitle: 'Hidratação intensa',
      description: 'Auxilia na hidratação e suavidade imediata da pele.',
      price: 'R$ 169,00',
      sortOrder: 2,
      images: [
        'https://images.unsplash.com/photo-1571781926291-c477ebfd024b?auto=format&fit=crop&w=900&q=80',
        'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=900&q=80',
      ],
    },
    {
      name: 'Sérum Retinol',
      subtitle: 'Lifting e renovação',
      description: 'Ajuda a reduzir sinais de expressão e melhorar textura.',
      price: 'R$ 189,00',
      sortOrder: 3,
      images: [
        'https://images.unsplash.com/photo-1515377905703-c4788e51af15?auto=format&fit=crop&w=900&q=80',
        'https://images.unsplash.com/photo-1521590832167-7bcbfaa6381f?auto=format&fit=crop&w=900&q=80',
      ],
    },
  ];

  for (const product of products) {
    const existingProduct = await prisma.shopProduct.findFirst({ where: { name: product.name } });
    if (!existingProduct) {
      await prisma.shopProduct.create({
        data: {
          name: product.name,
          subtitle: product.subtitle,
          description: product.description,
          price: product.price,
          imageUrl: product.images[0],
          images: product.images,
          sortOrder: product.sortOrder,
        },
      });
    }
  }

  console.log(`✅ Loja configurada: ${shopConfig.businessName} | código ${shopConfig.qrCodeNumber}`);

  // 2. Eventos Iniciais
  const event1 = await prisma.event.upsert({
    where: { publicSlug: 'consulfarma-2026' },
    update: {},
    create: {
      name: 'Congresso Consulfarma 2026',
      description: 'Maior congresso do setor magistral e farmacêutico da América Latina.',
      location: 'São Paulo Expo - SP',
      startDate: new Date('2026-07-02T08:00:00Z'),
      endDate: new Date('2026-07-05T20:00:00Z'),
      status: 'em_andamento',
      publicSlug: 'consulfarma-2026',
    },
  });

  const event2 = await prisma.event.upsert({
    where: { publicSlug: 'arnold-2026' },
    update: {},
    create: {
      name: 'Arnold Sports Festival South America',
      description: 'Feira internacional de nutrição esportiva, saúde e bem-estar.',
      location: 'Expo Center Norte - SP',
      startDate: new Date('2026-04-10T09:00:00Z'),
      endDate: new Date('2026-04-13T19:00:00Z'),
      status: 'em_andamento',
      publicSlug: 'arnold-2026',
    },
  });

  console.log(`✅ Eventos cadastrados: ${event1.name}, ${event2.name}`);
}

main()
  .catch((e) => {
    console.error('❌ Erro no seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
