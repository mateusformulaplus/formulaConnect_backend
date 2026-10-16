import dotenv from 'dotenv';
import { z } from 'zod';

const dotenvResult = dotenv.config();

if (dotenvResult.error && !('code' in dotenvResult.error && dotenvResult.error.code === 'ENOENT')) {
  console.error('❌ Não foi possível carregar o arquivo de ambiente:', dotenvResult.error);
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatória'),
  JWT_SECRET: z.string().min(8, 'JWT_SECRET deve ter ao menos 8 caracteres'),
  PORT: z.coerce.number().default(3333),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Erro nas variáveis de ambiente:', _env.error.format());
  throw new Error('Variáveis de ambiente inválidas');
}

export const env = _env.data;
