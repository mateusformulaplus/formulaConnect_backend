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
