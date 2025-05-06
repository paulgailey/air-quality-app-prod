// air-quality-worker.ts - Production Ready v2.2.0
import { Router } from 'itty-router';

// Augmentos SDK Type Declarations
declare class TpaServer {
  constructor(config: { packageName: string; apiKey: string });
}

declare class TpaSession {
  events: {
    onLocation: (callback: (coords: { lat: number; lng: number }) => void) => void;
    onTranscription: (callback: (data: { text: string; language?: string }) => void) => void;
  };
  layouts: {
    showTextWall: (text: string, options: { view: ViewType; durationMs: number }) => Promise<void>;
  };
}

declare enum ViewType {
  MAIN = 'main',
  SECONDARY = 'secondary'
}

// 1. Type Definitions =====================================================
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

// 2. Global Type Declarations =============================================
declare global {
  interface ResponseInit {
    webSocket?: WebSocket | null;
  }

  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }
}

// 3. Constants and Configuration ==========================================
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

// 4. Main Worker Class ====================================================
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

  // 5. Route Handlers =====================================================
  private setupRoutes() {
    this.router.get('/', () => this.jsonResponse({
      status: "running",
      version: "2.2.0",
      endpoints: ['/health', '/tpa_config.json']
    }));

    this.router.get('/health', (request: Request) => this.jsonResponse({
      status: "healthy",
      sessions: this.sessionMap.size,
      clientIp: request.headers.get('cf-connecting-ip')
    }));

    this.router.get('/tpa_config.json', () => this.jsonResponse({
      voiceCommands: VOICE_COMMANDS.map(phrase => ({
        phrase,
        description: "Check air quality"
      })),
      permissions: ["location"],
      transcriptionLanguages: ["en-US"]
    }));

    this.router.post('/webhook', async (request: Request) => {
      try {
        const data = await request.json() as SessionRequest;
        if (data.type === 'session_request') {
          await this.createSession(data.sessionId, data.userId);
          return this.jsonResponse({ status: 'success' });
        }
        return this.jsonResponse({ status: 'error' }, 400);
      } catch (err) {
        return this.jsonResponse({ status: 'error' }, 500);
      }
    });

    this.router.all('*', () => this.setCorsHeaders(new Response('Not Found', { status: 404 })));
  }

  // 6. TPA Integration ====================================================
  private setupTPAHooks() {
    interface TpaServerInternal {
      onSession: (session: TpaSession, sessionId: string, userId: string) => Promise<void>;
    }

    const server = this.tpaServer as unknown as TpaServerInternal;
    
    server.onSession = async (session: TpaSession, sessionId: string, userId: string) => {
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

  // 7. Core Functionality =================================================
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

    // Fallback to default location
    await this.showAirQuality(session, 51.5074, -0.1278, true);
  }

  private async getNearestAQIStation(lat: number, lon: number): Promise<AQIStationData> {
    const response = await fetch(`https://api.waqi.info/feed/geo:${lat};${lon}/?token=${this.env.AQI_TOKEN}`);
    const data = await response.json() as {
      status: string;
      data: any;
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

  // 8. Utility Methods ====================================================
  private async createSession(sessionId: string, userId: string): Promise<void> {
    await this.env.SESSIONS.put(
      `session#${sessionId}`,
      JSON.stringify({ userId, createdAt: Date.now() }),
      { expirationTtl: 86400 } // 24h expiration
    );
    this.sessionMap.set(sessionId, { userId, locationObtained: false });
  }
  
  public setCorsHeaders(response: Response): Response {
    // Get the allowed headers from environment or use defaults
    const allowedHeaders = this.env.CF_ALLOWED_HEADERS || 
      "X-Device-Latitude,X-Device-Longitude,X-Device-ID,X-App-Version";
      
    // Clone the response and add CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': allowedHeaders,
      'Access-Control-Max-Age': '86400',
    };
    
    const newResponse = new Response(response.body, response);
    Object.entries(corsHeaders).forEach(([key, value]) => {
      newResponse.headers.set(key, value);
    });
    
    return newResponse;
  }

  private jsonResponse(data: unknown, status = 200): Response {
    return this.setCorsHeaders(new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  // 9. Request Handling ===================================================
  public async handleRequest(request: Request, ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return this.setCorsHeaders(new Response(null, { status: 204 }));
    }
    
    // WebSocket handling with production check
    if (request.headers.get('Upgrade') === 'websocket') {
      // Always accept WebSocket connections for Augmentos
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

    // Normal HTTP request handling
    const response = await this.router.handle(request);
    
    // Apply CORS headers to all responses
    return this.setCorsHeaders(response);
  }
}

// 10. Worker Entry Point ==================================================
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Debugging: Log all environment variables (remove in production)
    console.log("Environment variables:", {
      hasAugmentosKey: !!env.AUGMENTOS_API_KEY,
      hasAqiToken: !!env.AQI_TOKEN,
      hasSessions: !!env.SESSIONS
    });

    if (!env.AUGMENTOS_API_KEY || !env.AQI_TOKEN) {
      console.error("Missing environment variables");
      return new Response('Missing required environment variables', { status: 500 });
    }

    try {
      console.log(`Incoming request: ${request.method} ${request.url}`);
      const worker = new AirQualityWorker(env);
      const response = await worker.handleRequest(request, ctx);
      console.log(`Response status: ${response.status}`);
      return response;
    } catch (error) {
      // Enhanced error logging
      console.error('CRITICAL ERROR:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack available',
        request: {
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers)
        }
      });
      
      // Return error details (remove in production)
      const errorResponse = new Response(
        `DEBUG MODE\nError: ${error instanceof Error ? error.message : 'Unknown error'}\nStack: ${error instanceof Error ? error.stack : 'No stack available'}`,
        { status: 500 }
      );
      
      // Add CORS headers to error responses too
      if (error instanceof AirQualityWorker) {
        return error.setCorsHeaders(errorResponse);
      }
      
      // Add basic CORS headers if we can't use the worker method
      errorResponse.headers.set('Access-Control-Allow-Origin', '*');
      return errorResponse;
    }
  }
};