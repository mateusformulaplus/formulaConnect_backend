import { buildApp } from './app.ts';
import { env } from './config/env.ts';

async function startServer() {
  const app = await buildApp();
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (error) {
    app.log.error(error, 'Falha ao iniciar o servidor backend');
    await app.close();
    process.exitCode = 1;
  }
}

void startServer().catch((error: unknown) => {
  console.error('Falha ao configurar o servidor backend:', error);
  process.exitCode = 1;
});
