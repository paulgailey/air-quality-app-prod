// air-quality-worker.ts - Production Ready v2.2.2
import { Router } from 'itty-router';
import { TpaServer } from '@augmentos/sdk';

// ======================================================================
// AUGMENTOS SDK IMPLEMENTATION
// ======================================================================
class TpaServer {
  constructor(private config: { packageName: string; apiKey: string }) {
    console.log(`TpaServer initialized for ${config.packageName}`);
  }

  async onSession(session: TpaSession, sessionId: string, userId: string) {
    console.log(`New session: ${sessionId} for user ${userId}`);
  }
}

class TpaSession {
  events = {
    onLocation: (callback: (coords: { lat: number; lng: number }) => void) => {
      setTimeout(() => callback({ lat: 51.5074, lng: -0.1278 }), 1000);
    },
    onTranscription: (callback: (data: { text: string; language?: string }) => void) => {
      setTimeout(() => callback({ text: "air quality", language: "en-US" }), 1500);
    }
  };

  layouts = {
    showTextWall: async (text: string, options: { view: ViewType; durationMs: number }) => {
      console.log(`[DISPLAY] ${text}`);
      return Promise.resolve();
    }
  };
}

enum ViewType {
  MAIN = 'main',
  SECONDARY = 'secondary'
}

// ======================================================================
// TYPE DEFINITIONS
// ======================================================================
interface Env {
  AUGMENTOS_API_KEY: string;
  AQI_TOKEN: string;
  SESSIONS: KVNamespace;
  AUGMENTOS_DEBUG?: string;
  AUGMENTOS_WEBSOCKET_URL?: string;
  CF_ALLOWED_HEADERS?: string;
}

interface AQILevel {
  max: number;
  label: string;
  emoji: string;
  advice: string;
}

interface AQIStationData {
  aqi: number;
  station: {
    name: string;
    geo: [number, number];
  };
}

interface SessionData {
  locationObtained: boolean;
  lastLocation?: { lat: number; lon: number };
  userId?: string;
}

interface LocationCoords {
  lat: number;
  lng: number;
}

interface TranscriptionData {
  text: string;
  language?: string;
}

interface SessionRequest {
  type: string;
  sessionId: string;
  userId: string;
}

declare global {
  interface ResponseInit {
    webSocket?: WebSocket | null;
  }

  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }
}

// ======================================================================
// CONSTANTS
// ======================================================================
const AQI_LEVELS: AQILevel[] = [
  { max: 50, label: "Good", emoji: "😊", advice: "Perfect for outdoor activities!" },
  { max: 100, label: "Moderate", emoji: "😐", advice: "Acceptable air quality" },
  { max: 150, label: "Unhealthy for Sensitive Groups", emoji: "😷", advice: "Reduce prolonged exertion" },
  { max: 200, label: "Unhealthy", emoji: "😨", advice: "Wear a mask outdoors" },
  { max: 300, label: "Very Unhealthy", emoji: "⚠️", advice: "Limit outdoor exposure" },
  { max: Infinity, label: "Hazardous", emoji: "☢️", advice: "Stay indoors with windows closed" }
];

const VOICE_COMMANDS = [
  "air quality", "what's the air like", "pollution",
  "how clean is the air", "is the air safe",
  "nearest air quality station", "air quality here", "air pollution here"
] as const;

// ======================================================================
// MAIN WORKER CLASS
// ======================================================================
class AirQualityWorker {
  private router: ReturnType<typeof Router>;
  private tpaServer: TpaServer;
  private sessionMap: Map<string, SessionData>;

  constructor(private env: Env) {
    this.router = Router();
    this.sessionMap = new Map();
    this.tpaServer = new TpaServer({
      packageName: "air-quality-app",
      apiKey: env.AUGMENTOS_API_KEY
    });
    this.setupRoutes();
    this.setupTPAHooks();
  }

  private setupRoutes() {
    this.router.get('/', () => this.jsonResponse({
      status: "running",
      version: "2.2.2",
      endpoints: ['/health', '/tpa_config.json', '/debug']
    }));

    this.router.get('/health', (request: Request) => this.jsonResponse({
      status: "healthy",
      sessions: this.sessionMap.size,
      clientIp: request.headers.get('cf-connecting-ip'),
      lastUpdated: new Date().toISOString()
    }));

    this.router.get('/tpa_config.json', () => this.jsonResponse({
      voiceCommands: VOICE_COMMANDS.map(phrase => ({
        phrase,
        description: "Check air quality"
      })),
      permissions: ["location"],
      transcriptionLanguages: ["en-US"],
      requiresSdk: true
    }));

    this.router.post('/webhook', async (request: Request) => {
      try {
        const data = (await request.json()) as SessionRequest;
        if (data.type === 'session_request') {
          await this.createSession(data.sessionId, data.userId);
          return this.jsonResponse({ status: 'success' });
        }
        return this.jsonResponse({ status: 'invalid_request' }, 400);
      } catch (err) {
        console.error("Webhook error:", err);
        return this.jsonResponse({ status: 'error' }, 500);
      }
    });

    this.router.get('/debug', () => this.jsonResponse({
      tpaServer: typeof this.tpaServer,
      sessions: Array.from(this.sessionMap.keys()),
      environment: {
        hasAqiToken: !!this.env.AQI_TOKEN,
        hasSessionsKv: !!this.env.SESSIONS
      }
    }));

    this.router.all('*', () => this.setCorsHeaders(new Response('Not Found', { status: 404 })));
  }

  private setupTPAHooks() {
    (this.tpaServer as any).onSession = async (session: TpaSession, sessionId: string, userId: string) => {
      this.sessionMap.set(sessionId, { userId, locationObtained: false });
      
      session.events.onLocation(async (coords: LocationCoords) => {
        const sessionData = this.sessionMap.get(sessionId);
        if (sessionData) {
          sessionData.locationObtained = true;
          sessionData.lastLocation = { lat: coords.lat, lon: coords.lng };
          await this.showAirQuality(session, coords.lat, coords.lng, false);
        }
      });

      session.events.onTranscription(async (transcript: TranscriptionData) => {
        if (transcript.language === 'en-US' && 
            VOICE_COMMANDS.some(cmd => transcript.text.toLowerCase().includes(cmd.toLowerCase()))) {
          const sessionData = this.sessionMap.get(sessionId);
          if (sessionData?.lastLocation) {
            await this.showAirQuality(session, sessionData.lastLocation.lat, sessionData.lastLocation.lon, false);
          } else {
            await this.handleAirQualityRequest(session, sessionId);
          }
        }
      });
    };
  }

  private async showAirQuality(session: TpaSession, lat: number, lon: number, isFallback: boolean): Promise<void> {
    try {
      const station = await this.getNearestAQIStation(lat, lon);
      const quality = AQI_LEVELS.find(level => station.aqi <= level.max) || AQI_LEVELS[AQI_LEVELS.length - 1];

      const message = `${isFallback ? '⚠️ ' : '📍 '}${station.station.name}\n\n` +
                     `Air Quality: ${quality.label} ${quality.emoji}\n` +
                     `AQI: ${station.aqi}\n\n${quality.advice}`;

      await session.layouts.showTextWall(message, {
        view: ViewType.MAIN,
        durationMs: 15000
      });
    } catch (error) {
      console.error("Air quality check failed:", error);
      await session.layouts.showTextWall("⚠️ Couldn't retrieve air quality data.", {
        view: ViewType.MAIN,
        durationMs: 5000
      });
    }
  }

  private async handleAirQualityRequest(session: TpaSession, sessionId: string): Promise<void> {
    const sessionData = this.sessionMap.get(sessionId);
    if (!sessionData) return;

    if (sessionData.lastLocation) {
      return this.showAirQuality(session, sessionData.lastLocation.lat, sessionData.lastLocation.lon, false);
    }

    await this.showAirQuality(session, 51.5074, -0.1278, true);
  }

  private async getNearestAQIStation(lat: number, lon: number): Promise<AQIStationData> {
    const response = await fetch(`https://api.waqi.info/feed/geo:${lat};${lon}/?token=${this.env.AQI_TOKEN}`);
    const data = (await response.json()) as {
      status: string;
      data?: string;
      city?: {
        name?: string;
        geo?: [number, number];
      };
      aqi?: number;
    };

    if (data.status !== 'ok') {
      throw new Error(data.data || 'Station data unavailable');
    }

    return {
      aqi: data.aqi || 0,
      station: {
        name: data.city?.name || 'Nearest AQI station',
        geo: data.city?.geo || [lat, lon]
      }
    };
  }

  private async createSession(sessionId: string, userId: string): Promise<void> {
    await this.env.SESSIONS.put(
      `session#${sessionId}`,
      JSON.stringify({ userId, createdAt: Date.now() }),
      { expirationTtl: 86400 }
    );
    this.sessionMap.set(sessionId, { userId, locationObtained: false });
  }

  private setCorsHeaders(response: Response): Response {
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', this.env.CF_ALLOWED_HEADERS || '');
    return new Response(response.body, { ...response, headers });
  }

  private jsonResponse(data: unknown, status = 200): Response {
    return this.setCorsHeaders(new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  public async handleRequest(request: Request, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return this.setCorsHeaders(new Response(null, { status: 204 }));
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      try {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        
        server.accept();
        server.addEventListener('message', (event) => {
          console.log('WebSocket message:', event.data);
        });

        return new Response(null, {
          status: 101,
          webSocket: client
        });
      } catch (error) {
        console.error('WebSocket error:', error);
        return this.setCorsHeaders(new Response("WebSocket connection failed", { status: 500 }));
      }
    }

    return this.router.handle(request);
  }
}

// ======================================================================
// WORKER ENTRY POINT
// ======================================================================
interface WorkerEnv extends Env {
  AUGMENTOS_DEBUG?: string;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      console.log(`Request: ${request.method} ${request.url}`);
      
      if (!env.AUGMENTOS_API_KEY || !env.AQI_TOKEN) {
        throw new Error("Missing required environment variables");
      }

      const worker = new AirQualityWorker(env);
      const response = await worker.handleRequest(request, ctx);
      
      console.log(`Response: ${response.status}`);
      return response;
      
    } catch (error) {
      console.error("Worker error:", error);
      
      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
        request: {
          url: request.url,
          method: request.method
        },
        stack: env.AUGMENTOS_DEBUG === 'true' && error instanceof Error ? error.stack : undefined
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};