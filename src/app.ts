import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { CommercialStatus, ContactType, EventStatus, Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from './config/env.ts';
import { isImageDataUri, ProductImageStorageError, uploadProductImages } from './services/productImageStorage.ts';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { id: string; email: string; name: string };
    user: { id: string; email: string; name: string };
  }
}

const prisma = new PrismaClient();

const contactTypes = Object.values(ContactType);
const commercialStatuses = Object.values(CommercialStatus);
const eventStatuses = Object.values(EventStatus);

const contactTypeLabels: Record<ContactType, string> = {
  influencer: 'Influenciador(a) / Criador(a) de Conteúdo',
  health_professional: 'Profissional da Saúde',
  pharmacy_business: 'Farmácia ou Estabelecimento Comercial',
  distributor_rep: 'Distribuidor(a) ou Representante Comercial',
  business_partner: 'Empresário(a) ou Empresa Interessada em Parceria',
};

const commercialStatusLabels: Record<CommercialStatus, string> = {
  novo_contato: 'Novo contato',
  aguardando_analise: 'Aguardando análise',
  contato_realizado: 'Contato realizado',
  em_negociacao: 'Em negociação',
  parceria_concluida: 'Parceria concluída',
  sem_interesse: 'Sem interesse',
};

const eventInclude = { _count: { select: { leads: true } } } satisfies Prisma.EventInclude;
const leadInclude = {
  event: { select: { id: true, name: true, publicSlug: true } },
  assignedTo: { select: { id: true, name: true, email: true } },
  history: {
    orderBy: { createdAt: 'desc' as const },
    include: { adminUser: { select: { name: true } } },
  },
} satisfies Prisma.LeadInclude;

const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'Sessão inválida ou expirada. Faça login novamente.' });
  }
};

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function isLegacyBrazilianMobile(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  const local = digits.startsWith('55') && (digits.length === 12 || digits.length === 13)
    ? digits.slice(2)
    : digits;
  return local.length === 10 && '6789'.includes(local[2] || '');
}

function isValidBrazilianPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  const local = digits.startsWith('55') && (digits.length === 12 || digits.length === 13)
    ? digits.slice(2)
    : digits;
  const ddd = Number(local.slice(0, 2));
  return (
    (local.length === 10 && '2345'.includes(local[2] || ''))
    || (local.length === 11 && local[2] === '9')
  ) && ddd >= 11 && ddd <= 99;
}

function makeSlug(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function parseDateFilter(value: unknown, endOfDay = false): Date | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) date.setUTCHours(23, 59, 59, 999);
  return date;
}

function buildWhatsAppLink(phone: string, message: string): string {
  const normalized = normalizePhone(phone);
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}

type LeadWithRelations = Prisma.LeadGetPayload<{ include: typeof leadInclude }>;

function serializeLead(lead: LeadWithRelations) {
  const { history, ...data } = lead;
  return {
    ...data,
    history: history.map(({ adminUser, ...entry }) => ({
      ...entry,
      adminUserName: adminUser?.name,
    })),
  };
}

const leadQuerySchema = z.object({
  search: z.string().optional(),
  category: z.nativeEnum(ContactType).or(z.literal('all')).optional(),
  status: z.nativeEnum(CommercialStatus).or(z.literal('all')).optional(),
  eventId: z.string().optional(),
  startDate: z.string().refine((value) => parseDateFilter(value) !== undefined).optional(),
  endDate: z.string().refine((value) => parseDateFilter(value) !== undefined).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(10000).default(15),
  sortBy: z.enum(['createdAt', 'fullName', 'commercialStatus']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const eventFieldsSchema = z.object({
  name: z.string().trim().min(3).max(200),
  description: z.string().trim().optional().nullable(),
  location: z.string().trim().optional().nullable(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  status: z.nativeEnum(EventStatus).optional(),
  publicSlug: z.string().trim().min(1).optional(),
});

const eventBodySchema = eventFieldsSchema.refine((event) => event.endDate >= event.startDate, {
  message: 'A data de término deve ser igual ou posterior à data de início.',
  path: ['endDate'],
});

const eventPatchSchema = eventFieldsSchema.partial().refine((event) => (
  event.startDate === undefined || event.endDate === undefined || event.endDate >= event.startDate
), {
  message: 'A data de término deve ser igual ou posterior à data de início.',
  path: ['endDate'],
});

export async function buildApp() {
  const app = Fastify({ logger: true, bodyLimit: 8 * 1024 * 1024 });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const statusCode = error instanceof Error
      && 'statusCode' in error
      && typeof error.statusCode === 'number'
      && error.statusCode >= 400
      && error.statusCode < 500
      ? error.statusCode
      : 500;
    const errorMessage = error instanceof Error && statusCode !== 500
      ? error.message
      : 'Erro interno do servidor.';

    return reply.code(statusCode).send({
      error: errorMessage,
    });
  });

  const allowedOrigins = new Set([
    'https://formulaconnect.vercel.app',
    ...env.FRONTEND_URL.split(',').map((origin) => origin.trim()).filter(Boolean),
  ]);
  await app.register(cors, {
    origin: (origin, callback) => callback(null, origin ? allowedOrigins.has(origin) : false),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(jwt, { secret: env.JWT_SECRET, sign: { expiresIn: '7d' } });
  await app.register(rateLimit, { global: false });
  app.addHook('onClose', async () => prisma.$disconnect());

  app.get('/health', async () => ({ status: 'ok' }));

  app.post<{ Body: { email?: string; password?: string } }>('/api/auth/login', {
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const input = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'E-mail e senha válidos são obrigatórios.' });

    const user = await prisma.adminUser.findUnique({ where: { email: input.data.email.toLowerCase() } });
    if (!user || !(await bcrypt.compare(input.data.password, user.passwordHash))) {
      return reply.code(401).send({ error: 'Credenciais inválidas. Verifique seu e-mail e sua senha.' });
    }

    const token = app.jwt.sign({ id: user.id, email: user.email, name: user.name });
    return {
      token,
      user: { id: user.id, name: user.name, email: user.email },
    };
  });

  app.get('/api/auth/me', { preHandler: authenticate }, async (request, reply) => {
    const user = await prisma.adminUser.findUnique({
      where: { id: request.user.id },
      select: { id: true, name: true, email: true },
    });
    if (!user) return reply.code(404).send({ error: 'Usuário não encontrado.' });
    return user;
  });


  app.get("/api/health", async () => {
    return {
        status: "ok"
    }
})


  app.get('/api/admin/users', { preHandler: authenticate }, async () => (
    prisma.adminUser.findMany({
      select: { id: true, name: true, email: true, createdAt: true, updatedAt: true },
      orderBy: { name: 'asc' },
    })
  ));

  app.get<{ Params: { slug: string } }>('/api/public/events/:slug', {
    config: { rateLimit: { max: 100, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const event = await prisma.event.findUnique({ where: { publicSlug: request.params.slug } });
    if (!event) return reply.code(404).send({ error: 'Evento não encontrado.' });
    if (event.status === EventStatus.encerrado) {
      return reply.code(400).send({
        error: 'As inscrições para este evento já foram encerradas.',
        event: { id: event.id, name: event.name, status: event.status },
      });
    }
    return {
      id: event.id,
      name: event.name,
      description: event.description,
      location: event.location,
      publicSlug: event.publicSlug,
      status: event.status,
    };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/public/leads', {
    config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const schema = z.object({
      fullName: z.string().trim().min(2),
      email: z.string().trim().email().optional().or(z.literal('')),
      whatsapp: z.string().min(1),
      city: z.string().trim().min(2),
      state: z.string().trim().min(2).max(2),
      professionalProfile: z.string().optional(),
      contactType: z.nativeEnum(ContactType),
      marketingConsent: z.boolean().default(false),
      consentNoticeVersion: z.string().optional(),
      eventSlug: z.string().min(1),
    });
    const input = schema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Confira os dados obrigatórios do formulário.' });
    if (!isValidBrazilianPhone(input.data.whatsapp)) {
      return reply.code(400).send({ error: 'Informe um número de WhatsApp válido com DDD.' });
    }

    const event = await prisma.event.findUnique({ where: { publicSlug: input.data.eventSlug } });
    if (!event) return reply.code(400).send({ error: 'O evento informado não existe.' });
    if (event.status === EventStatus.encerrado) {
      return reply.code(400).send({ error: 'A captação para este evento já foi encerrada.' });
    }

    const lead = await prisma.lead.create({
      data: {
        fullName: input.data.fullName,
        email: input.data.email || null,
        whatsapp: input.data.whatsapp.trim(),
        normalizedWhatsapp: normalizePhone(input.data.whatsapp),
        city: input.data.city,
        state: input.data.state.toUpperCase(),
        professionalProfile: input.data.professionalProfile?.trim() || null,
        contactType: input.data.contactType,
        marketingConsent: input.data.marketingConsent,
        consentAt: new Date(),
        consentNoticeVersion: input.data.consentNoticeVersion || 'v1.0',
        eventId: event.id,
      },
    });
    return reply.code(201).send({
      success: true,
      message: 'Cadastro realizado com sucesso!',
      leadId: lead.id,
    });
  });

  app.get('/api/shop/config', async () => {
    const config = await prisma.shopConfig.findFirst({ where: { active: true }, orderBy: { createdAt: 'desc' } });
    if (config) return config;
    return {
      id: 'default',
      businessName: 'Fórmula Plus',
      whatsapp: '5511999999999',
      defaultMessage: 'Olá! Gostaria de saber mais sobre os produtos da Fórmula Plus.',
      qrCodeNumber: '123456',
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });

  app.get('/api/shop/products', async () => {
    const products = await prisma.shopProduct.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return products;
  });

  app.post<{ Body: Record<string, unknown> }>('/api/shop/orders', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const schema = z.object({
      customerName: z.string().trim().min(2),
      email: z.string().trim().email().optional().or(z.literal('')),
      whatsapp: z.string().trim().min(8).optional().or(z.literal('')),
      productName: z.string().trim().min(2),
      productId: z.string().optional(),
      quantity: z.coerce.number().int().min(1).max(99).default(1),
      source: z.enum(['qr', 'manual']).default('manual'),
      qrCodeNumber: z.string().trim().optional(),
      message: z.string().trim().optional(),
    }).strict();

    const input = schema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Dados do pedido inválidos.' });
    if (input.data.whatsapp && !isValidBrazilianPhone(input.data.whatsapp)) {
      return reply.code(400).send({ error: 'Informe um WhatsApp válido com DDD.' });
    }

    const config = await prisma.shopConfig.findFirst({ where: { active: true }, orderBy: { createdAt: 'desc' } });
    const order = await prisma.shopOrder.create({
      data: {
        customerName: input.data.customerName,
        email: input.data.email || null,
        whatsapp: input.data.whatsapp?.trim() || '',
        productName: input.data.productName,
        productId: input.data.productId || null,
        quantity: input.data.quantity,
        source: input.data.source,
        qrCodeNumber: input.data.qrCodeNumber || null,
        message: input.data.message || null,
      },
    });

    const whatsappBaseMessage = input.data.message || config?.defaultMessage || 'Olá! Gostaria de saber mais sobre os produtos da Fórmula Plus.';
    const shareableLink = config ? buildWhatsAppLink(config.whatsapp, whatsappBaseMessage) : '';

    return reply.code(201).send({
      success: true,
      orderId: order.id,
      whatsappLink: shareableLink,
      message: 'Pedido registrado com sucesso.',
    });
  });

  app.get('/api/shop/admin/orders', { preHandler: authenticate }, async () => {
    return prisma.shopOrder.findMany({
      orderBy: { createdAt: 'desc' },
    });
  });

  app.get('/api/shop/admin/config', { preHandler: authenticate }, async () => {
    const config = await prisma.shopConfig.findFirst({ orderBy: { createdAt: 'desc' } });
    if (config) return config;
    return {
      id: '',
      businessName: 'Fórmula Plus',
      whatsapp: '5511999999999',
      defaultMessage: 'Olá! Gostaria de saber mais sobre os produtos da Fórmula Plus.',
      qrCodeNumber: '123456',
      active: true,
      createdAt: null,
      updatedAt: null,
    };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/shop/admin/config', { preHandler: authenticate }, async (request, reply) => {
    const schema = z.object({
      businessName: z.string().trim().min(2).max(120).optional(),
      whatsapp: z.string().trim().min(8).max(30),
      defaultMessage: z.string().trim().min(10).max(500).optional(),
      qrCodeNumber: z.string().trim().min(1).max(20),
      active: z.boolean().optional(),
    }).strict();
    const input = schema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Configuração da loja inválida.' });
    if (isLegacyBrazilianMobile(input.data.whatsapp)) {
      return reply.code(400).send({
        error: 'Este celular está no formato antigo, com 8 dígitos após o DDD. Informe o número atual com 9 dígitos.',
      });
    }
    if (!isValidBrazilianPhone(input.data.whatsapp)) {
      return reply.code(400).send({ error: 'WhatsApp da loja deve ser válido com DDD.' });
    }

    const existing = await prisma.shopConfig.findFirst({ orderBy: { createdAt: 'desc' } });
    const payload = {
      businessName: input.data.businessName || existing?.businessName || 'Fórmula Plus',
      whatsapp: normalizePhone(input.data.whatsapp),
      defaultMessage: input.data.defaultMessage || existing?.defaultMessage || 'Olá! Gostaria de saber mais sobre os produtos da Fórmula Plus.',
      qrCodeNumber: input.data.qrCodeNumber,
      active: input.data.active ?? true,
    };

    try {
      if (existing) {
        const updated = await prisma.shopConfig.update({
          where: { id: existing.id },
          data: payload,
        });
        return updated;
      }

      const created = await prisma.shopConfig.create({ data: payload });
      return reply.code(201).send(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return reply.code(409).send({ error: 'Já existe um código QR ativo com esse valor.' });
      }
      throw error;
    }
  });

  app.get('/api/shop/admin/products', { preHandler: authenticate }, async () => {
    const products = await prisma.shopProduct.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return products;
  });

  const productImageSchema = z.string().trim().min(1).refine(
    (image) => image.length <= 500
      || (
        image.length <= 1_400_000
        && isImageDataUri(image)
      ),
    'Imagem deve ser uma URL de até 500 caracteres ou uma imagem JPG, PNG, WebP, GIF ou AVIF de até 1 MB.',
  );

  app.post<{ Body: Record<string, unknown> }>('/api/shop/admin/products', { preHandler: authenticate }, async (request, reply) => {
    const schema = z.object({
      name: z.string().trim().min(2).max(120),
      subtitle: z.string().trim().max(200).optional().or(z.literal('')),
      description: z.string().trim().max(5000).optional().or(z.literal('')),
      price: z.string().trim().max(50).optional().or(z.literal('')),
      imageUrl: productImageSchema.optional().or(z.literal('')),
      images: z.array(productImageSchema).max(5).default([]),
      active: z.boolean().default(true),
      sortOrder: z.coerce.number().int().min(0).default(0),
    }).strict();
    const input = schema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({
        error: 'Dados do produto inválidos.',
        details: input.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    try {
      const imageInputs = input.data.images.length
        ? input.data.images
        : input.data.imageUrl
          ? [input.data.imageUrl]
          : [];
      const images = await uploadProductImages(imageInputs);
      const product = await prisma.shopProduct.create({
        data: {
          name: input.data.name,
          subtitle: input.data.subtitle || null,
          description: input.data.description || null,
          price: input.data.price || '',
          imageUrl: images[0] || null,
          images,
          active: input.data.active,
          sortOrder: input.data.sortOrder,
        },
      });
      return reply.code(201).send(product);
    } catch (error) {
      if (error instanceof ProductImageStorageError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/shop/admin/products/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const schema = z.object({
      name: z.string().trim().min(2).max(120).optional(),
      subtitle: z.string().trim().max(200).optional().nullable(),
      description: z.string().trim().max(5000).optional().nullable(),
      price: z.string().trim().max(50).optional().nullable(),
      imageUrl: productImageSchema.optional().nullable().or(z.literal('')),
      images: z.array(productImageSchema).max(5).optional(),
      active: z.boolean().optional(),
      sortOrder: z.coerce.number().int().min(0).optional(),
    }).strict();
    const input = schema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({
        error: 'Dados de atualização inválidos.',
        details: input.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    try {
      const imageInputs = input.data.images ?? (
        input.data.imageUrl === undefined
          ? undefined
          : input.data.imageUrl
            ? [input.data.imageUrl]
            : []
      );
      const images = imageInputs === undefined ? undefined : await uploadProductImages(imageInputs);
      const payload = {
        ...input.data,
        price: input.data.price ?? undefined,
        imageUrl: images === undefined ? input.data.imageUrl ?? undefined : images[0] ?? null,
        images,
      };
      const product = await prisma.shopProduct.update({
        where: { id: request.params.id },
        data: payload,
      });
      return product;
    } catch (error) {
      if (error instanceof ProductImageStorageError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return reply.code(404).send({ error: 'Produto não encontrado.' });
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/shop/admin/products/:id', { preHandler: authenticate }, async (request, reply) => {
    const productId = request.params.id;
    const deleted = await prisma.$transaction(async (tx) => {
      await tx.shopOrder.updateMany({
        where: { productId },
        data: { productId: null },
      });
      return tx.shopProduct.deleteMany({ where: { id: productId } });
    });

    if (deleted.count === 0) {
      return reply.code(404).send({ error: 'Produto não encontrado.' });
    }
    return { success: true, message: 'Produto removido com sucesso.' };
  });

  app.get('/api/leads', { preHandler: authenticate }, async (request, reply) => {
    const parsed = leadQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Filtros de contatos inválidos.' });
    const { search, category, status, eventId, startDate, endDate, page, pageSize, sortBy, sortOrder } = parsed.data;
    const where: Prisma.LeadWhereInput = {
      ...(category && category !== 'all' ? { contactType: category } : {}),
      ...(status && status !== 'all' ? { commercialStatus: status } : {}),
      ...(eventId && eventId !== 'all' ? { eventId } : {}),
      ...((startDate || endDate) ? {
        createdAt: {
          ...(parseDateFilter(startDate) ? { gte: parseDateFilter(startDate) } : {}),
          ...(parseDateFilter(endDate, true) ? { lte: parseDateFilter(endDate, true) } : {}),
        },
      } : {}),
      ...(search ? {
        OR: ['fullName', 'email', 'whatsapp', 'city', 'professionalProfile'].map((field) => ({
          [field]: { contains: search, mode: 'insensitive' as const },
        })),
      } : {}),
    };
    const [total, leads] = await prisma.$transaction([
      prisma.lead.count({ where }),
      prisma.lead.findMany({
        where,
        include: leadInclude,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const duplicateConditions = leads.flatMap((lead) => [
      { normalizedWhatsapp: lead.normalizedWhatsapp },
      ...(lead.email ? [{ email: { equals: lead.email, mode: 'insensitive' as const } }] : []),
    ]);
    const duplicates = duplicateConditions.length
      ? await prisma.lead.findMany({ where: { OR: duplicateConditions }, select: { id: true, normalizedWhatsapp: true, email: true } })
      : [];
    const leadsWithDuplicates = leads.map((lead) => ({
      ...serializeLead(lead),
      isDuplicate: duplicates.some((item) => item.id !== lead.id && (
        item.normalizedWhatsapp === lead.normalizedWhatsapp ||
        (lead.email && item.email?.toLowerCase() === lead.email.toLowerCase())
      )),
    }));
    return { leads: leadsWithDuplicates, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  });

  app.get('/api/leads/export', { preHandler: authenticate }, async (request, reply) => {
    const parsed = leadQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Filtros de contatos inválidos.' });
    const { search, category, status, eventId, startDate, endDate } = parsed.data;
    const where: Prisma.LeadWhereInput = {
      ...(category && category !== 'all' ? { contactType: category } : {}),
      ...(status && status !== 'all' ? { commercialStatus: status } : {}),
      ...(eventId && eventId !== 'all' ? { eventId } : {}),
      ...((startDate || endDate) ? { createdAt: {
        ...(parseDateFilter(startDate) ? { gte: parseDateFilter(startDate) } : {}),
        ...(parseDateFilter(endDate, true) ? { lte: parseDateFilter(endDate, true) } : {}),
      } } : {}),
      ...(search ? { OR: ['fullName', 'email', 'whatsapp', 'city', 'professionalProfile'].map((field) => ({
        [field]: { contains: search, mode: 'insensitive' as const },
      })) } : {}),
    };
    const leads = await prisma.lead.findMany({
      where,
      include: { event: { select: { name: true } }, assignedTo: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const headers = ['ID', 'Nome Completo', 'E-mail', 'WhatsApp', 'Cidade', 'Estado', 'Perfil Profissional',
      'Tipo de Contato', 'Status Comercial', 'Evento de Origem', 'Responsável',
      'Consentimento Marketing', 'Data de Cadastro', 'Observações'];
    const rows = leads.map((lead) => [
      lead.id, lead.fullName, lead.email, lead.whatsapp, lead.city, lead.state, lead.professionalProfile,
      contactTypeLabels[lead.contactType], commercialStatusLabels[lead.commercialStatus],
      lead.event?.name || 'Geral / Sem evento', lead.assignedTo?.name || 'Não atribuído',
      lead.marketingConsent ? 'Sim' : 'Não', lead.createdAt.toISOString(), lead.notes,
    ].map(escape).join(';'));
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="leads-formula-plus-${new Date().toISOString().slice(0, 10)}.csv"`);
    return reply.send(`\uFEFF${[headers.join(';'), ...rows].join('\r\n')}`);
  });

  app.get<{ Params: { id: string } }>('/api/leads/:id', { preHandler: authenticate }, async (request, reply) => {
    const lead = await prisma.lead.findUnique({ where: { id: request.params.id }, include: leadInclude });
    if (!lead) return reply.code(404).send({ error: 'Contato não encontrado.' });
    return serializeLead(lead);
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/leads/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const schema = z.object({
      commercialStatus: z.nativeEnum(CommercialStatus).optional(),
      notes: z.string().nullable().optional(),
      assignedToId: z.string().nullable().optional(),
    }).strict();
    const input = schema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Dados de atualização inválidos.' });
    const previous = await prisma.lead.findUnique({ where: { id: request.params.id } });
    if (!previous) return reply.code(404).send({ error: 'Contato não encontrado para atualização.' });

    const history: Prisma.LeadHistoryCreateManyInput[] = [];
    if (input.data.commercialStatus && input.data.commercialStatus !== previous.commercialStatus) {
      history.push({
        leadId: previous.id,
        adminUserId: request.user.id,
        action: 'Alteração de status',
        previousValue: commercialStatusLabels[previous.commercialStatus],
        newValue: commercialStatusLabels[input.data.commercialStatus],
      });
    }
    if (input.data.assignedToId !== undefined && input.data.assignedToId !== previous.assignedToId) {
      history.push({
        leadId: previous.id,
        adminUserId: request.user.id,
        action: 'Atribuição de responsável',
        previousValue: previous.assignedToId || 'Sem responsável',
        newValue: input.data.assignedToId || 'Sem responsável',
      });
    }
    await prisma.lead.update({ where: { id: previous.id }, data: input.data });

    let historySaved = true;
    if (history.length) {
      try {
        await prisma.leadHistory.createMany({ data: history });
      } catch (error) {
        historySaved = false;
        request.log.error({ err: error, leadId: previous.id }, 'Não foi possível registrar o histórico do lead.');
      }
    }

    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: previous.id }, include: leadInclude });
    return { ...serializeLead(updated), historySaved };
  });

  app.delete<{ Params: { id: string } }>('/api/leads/:id', { preHandler: authenticate }, async (request, reply) => {
    const result = await prisma.lead.deleteMany({ where: { id: request.params.id } });
    if (!result.count) return reply.code(404).send({ error: 'Contato não encontrado.' });
    return { success: true, message: 'Contato excluído com sucesso.' };
  });

  const dashboardFilter = (query: unknown) => {
    const parsed = z.object({
      eventId: z.string().optional(),
      category: z.nativeEnum(ContactType).or(z.literal('all')).optional(),
    }).safeParse(query);
    if (!parsed.success) return null;
    return {
      ...(parsed.data.eventId && parsed.data.eventId !== 'all' ? { eventId: parsed.data.eventId } : {}),
      ...(parsed.data.category && parsed.data.category !== 'all' ? { contactType: parsed.data.category } : {}),
    } satisfies Prisma.LeadWhereInput;
  };

  app.get('/api/dashboard/metrics', { preHandler: authenticate }, async (request, reply) => {
    const where = dashboardFilter(request.query);
    if (!where) return reply.code(400).send({ error: 'Filtros do painel inválidos.' });
    const since = (days: number) => new Date(Date.now() - days * 86400000);
    const [totalLeads, leadsToday, leadsLast7Days, leadsLast30Days, grouped, uncontactedCount, concludedPartnershipsCount] =
      await Promise.all([
        prisma.lead.count({ where }),
        prisma.lead.count({ where: { ...where, createdAt: { gte: since(1) } } }),
        prisma.lead.count({ where: { ...where, createdAt: { gte: since(7) } } }),
        prisma.lead.count({ where: { ...where, createdAt: { gte: since(30) } } }),
        prisma.lead.groupBy({ by: ['contactType'], where, _count: { _all: true } }),
        prisma.lead.count({ where: { ...where, commercialStatus: CommercialStatus.novo_contato } }),
        prisma.lead.count({ where: { ...where, commercialStatus: CommercialStatus.parceria_concluida } }),
      ]);
    const byType = Object.fromEntries(contactTypes.map((type) => [type, 0])) as Record<ContactType, number>;
    for (const row of grouped) byType[row.contactType] = row._count._all;
    return { totalLeads, leadsToday, leadsLast7Days, leadsLast30Days, byType, uncontactedCount, concludedPartnershipsCount };
  });

  app.get('/api/dashboard/leads-over-time', { preHandler: authenticate }, async (request, reply) => {
    const parsed = z.object({
      eventId: z.string().optional(),
      category: z.nativeEnum(ContactType).or(z.literal('all')).optional(),
      days: z.coerce.number().int().min(1).max(365).default(14),
    }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Filtros do painel inválidos.' });
    const { eventId, category, days } = parsed.data;
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const leads = await prisma.lead.findMany({
      where: {
        createdAt: { gte: start },
        ...(eventId && eventId !== 'all' ? { eventId } : {}),
        ...(category && category !== 'all' ? { contactType: category } : {}),
      },
      select: { createdAt: true },
    });
    const totals = new Map<string, number>();
    for (const lead of leads) {
      const key = lead.createdAt.toISOString().slice(0, 10);
      totals.set(key, (totals.get(key) || 0) + 1);
    }
    return Array.from({ length: days }, (_, index) => {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + index);
      const key = date.toISOString().slice(0, 10);
      return { date: key, label: date.toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }), total: totals.get(key) || 0 };
    });
  });

  app.get('/api/dashboard/leads-by-type', { preHandler: authenticate }, async (request, reply) => {
    const parsed = z.object({ eventId: z.string().optional() }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Filtros do painel inválidos.' });
    const where = parsed.data.eventId && parsed.data.eventId !== 'all' ? { eventId: parsed.data.eventId } : {};
    const [total, grouped] = await Promise.all([
      prisma.lead.count({ where }),
      prisma.lead.groupBy({ by: ['contactType'], where, _count: { _all: true } }),
    ]);
    const counts = new Map(grouped.map((row) => [row.contactType, row._count._all]));
    return contactTypes.map((type) => {
      const count = counts.get(type) || 0;
      return { type, label: contactTypeLabels[type], count, percentage: total ? Math.round((count / total) * 100) : 0 };
    });
  });

  app.get('/api/dashboard/leads-by-status', { preHandler: authenticate }, async (request, reply) => {
    const parsed = z.object({
      eventId: z.string().optional(),
      category: z.nativeEnum(ContactType).or(z.literal('all')).optional(),
    }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Filtros do painel inválidos.' });
    const where = {
      ...(parsed.data.eventId && parsed.data.eventId !== 'all' ? { eventId: parsed.data.eventId } : {}),
      ...(parsed.data.category && parsed.data.category !== 'all' ? { contactType: parsed.data.category } : {}),
    };
    const grouped = await prisma.lead.groupBy({ by: ['commercialStatus'], where, _count: { _all: true } });
    const counts = new Map(grouped.map((row) => [row.commercialStatus, row._count._all]));
    return commercialStatuses.map((status) => ({
      status,
      label: commercialStatusLabels[status],
      count: counts.get(status) || 0,
    }));
  });

  app.get('/api/dashboard/events-performance', { preHandler: authenticate }, async () => {
    const events = await prisma.event.findMany({
      include: {
        _count: { select: { leads: true } },
        leads: { where: { commercialStatus: CommercialStatus.parceria_concluida }, select: { id: true } },
      },
      orderBy: { startDate: 'desc' },
    });
    return events.map((event) => ({
      id: event.id,
      name: event.name,
      slug: event.publicSlug,
      leadsCount: event._count.leads,
      concludedCount: event.leads.length,
    }));
  });

  app.get('/api/events', { preHandler: authenticate }, async () => (
    prisma.event.findMany({ include: eventInclude, orderBy: { startDate: 'desc' } })
  ));

  app.post<{ Body: Record<string, unknown> }>('/api/events', { preHandler: authenticate }, async (request, reply) => {
    const input = eventBodySchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Dados do evento inválidos.', details: input.error.flatten() });
    const publicSlug = input.data.publicSlug || makeSlug(input.data.name);
    try {
      const event = await prisma.event.create({
        data: { ...input.data, publicSlug, status: input.data.status || EventStatus.planejado },
        include: eventInclude,
      });
      return reply.code(201).send(event);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return reply.code(409).send({ error: 'Já existe um evento com este link público.' });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/api/events/:id', { preHandler: authenticate }, async (request, reply) => {
    const event = await prisma.event.findUnique({ where: { id: request.params.id }, include: eventInclude });
    if (!event) return reply.code(404).send({ error: 'Evento não encontrado.' });
    return event;
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/events/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const input = eventPatchSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Dados de atualização inválidos.', details: input.error.flatten() });
    const current = await prisma.event.findUnique({
      where: { id: request.params.id },
      select: { startDate: true, endDate: true },
    });
    if (!current) return reply.code(404).send({ error: 'Evento não encontrado para atualização.' });
    const startDate = input.data.startDate || current.startDate;
    const endDate = input.data.endDate || current.endDate;
    if (endDate < startDate) {
      return reply.code(400).send({ error: 'A data de término deve ser igual ou posterior à data de início.' });
    }
    try {
      return await prisma.event.update({
        where: { id: request.params.id },
        data: input.data,
        include: eventInclude,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return reply.code(404).send({ error: 'Evento não encontrado para atualização.' });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return reply.code(409).send({ error: 'Já existe um evento com este link público.' });
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/events/:id', { preHandler: authenticate }, async (request, reply) => {
    try {
      await prisma.event.delete({ where: { id: request.params.id } });
      return { success: true, message: 'Evento removido com sucesso.' };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return reply.code(404).send({ error: 'Evento não encontrado.' });
      }
      throw error;
    }
  });

  return app;
}
