import { Router } from 'itty-router';

interface Env {
  AUGMENTOS_API_KEY: string;
  AQI_TOKEN: string;
  SESSIONS: KVNamespace;
}

const router = Router();

// Health check route
router.get('/health', (request) => {
  const env = (request as any).env as Env;

  return new Response(JSON.stringify({
    status: 'healthy',
    varsLoaded: !!env.AUGMENTOS_API_KEY && !!env.AQI_TOKEN,
    kvConnected: !!env.SESSIONS
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Catch-all 404 handler
router.all('*', () => {
  return new Response('Not found', { status: 404 });
});

// Worker entry point
export default {
  async fetch(request: Request, env: Env) {
    try {
      // Attach env to request so routes can access it
      (request as any).env = env;

      const response = await router.handle(request);
      return response instanceof Response
        ? response
        : new Response('Internal Error', { status: 500 });
    } catch (err) {
      return new Response('Server Error: ' + (err as Error).message, {
        status: 500
      });
    }
  }
};
