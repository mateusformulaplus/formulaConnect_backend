import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { CommercialStatus, ContactType, EventStatus, Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from './config/env.ts';

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

function isValidBrazilianPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  const local = digits.startsWith('55') && (digits.length === 12 || digits.length === 13)
    ? digits.slice(2)
    : digits;
  const ddd = Number(local.slice(0, 2));
  return (local.length === 10 || (local.length === 11 && local[2] === '9')) && ddd >= 11 && ddd <= 99;
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
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: env.FRONTEND_URL });
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
    const updated = await prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: previous.id }, data: input.data });
      if (history.length) await tx.leadHistory.createMany({ data: history });
      return tx.lead.findUniqueOrThrow({ where: { id: previous.id }, include: leadInclude });
    });
    return serializeLead(updated);
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
