// Version: 2.0.0 - Cloudflare Pages Deployed VERSION
// Core Node.js modules (correctly prefixed)
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

// External dependencies
import express, { Request, Response, NextFunction } from "express";
import axios from "axios";
import { TpaServer, TpaSession, ViewType } from "@augmentos/sdk";



// ESM compatible dirname (replacing __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// App configuration
const APP_VERSION = '2.0.0';
const PORT = parseInt(process.env.PORT || '3000', 10);
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'air-quality-app';
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY || '';
const AQI_TOKEN = process.env.AQI_TOKEN || '';

// Validate environment
if (!AUGMENTOS_API_KEY || !AQI_TOKEN) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

// AQI categories
interface AQILevel {
  max: number;
  label: string;
  emoji: string;
  advice: string;
}

const AQI_LEVELS: AQILevel[] = [
  { max: 50, label: "Good", emoji: "😊", advice: "Perfect for outdoor activities!" },
  { max: 100, label: "Moderate", emoji: "😐", advice: "Acceptable air quality" },
  { max: 150, label: "Unhealthy for Sensitive Groups", emoji: "😷", advice: "Reduce prolonged exertion" },
  { max: 200, label: "Unhealthy", emoji: "😨", advice: "Wear a mask outdoors" },
  { max: 300, label: "Very Unhealthy", emoji: "⚠️", advice: "Limit outdoor exposure" },
  { max: Infinity, label: "Hazardous", emoji: "☢️", advice: "Stay indoors with windows closed" }
];

interface AQIStationData {
  aqi: number;
  station: {
    name: string;
    geo: [number, number];
  };
}

interface SessionExtension {
  locationObtained: boolean;
  lastLocation?: { lat: number; lon: number };
}

interface SessionInitParams {
  sessionId: string;
  userId: string;
  packageName: string;
}

interface TranscriptionData {
  text: string;
  language?: string;
}

interface LocationCoords {
  lat: number;
  lng: number;
}

class AirQualityApp extends TpaServer {
  private readonly VOICE_COMMANDS: string[] = [
    "air quality", "what's the air like", "pollution",
    "how clean is the air", "is the air safe",
    "nearest air quality station", "air quality here", "air pollution here"
  ];

  private expressApp: express.Express;
  private sessionExtensions: Map<string, SessionExtension>;

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: AUGMENTOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, '../public')
    });

    this.expressApp = express();
    this.sessionExtensions = new Map<string, SessionExtension>();
    this.expressApp.set('trust proxy', true);
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.expressApp.use(express.json());

    // Add basic headers
    this.expressApp.use((req: Request, res: Response, next: NextFunction) => {
      res.set('X-Request-ID', crypto.randomUUID());
      next();
    });

    this.expressApp.get('/', (req: Request, res: Response) => {
      res.json({
        status: "running",
        version: APP_VERSION,
        endpoints: ['/health', '/tpa_config.json']
      });
    });

    this.expressApp.get('/health', (req: Request, res: Response) => {
      res.json({
        status: "healthy",
        sessions: this.sessionExtensions.size,
        clientIp: req.headers['cf-connecting-ip'] || req.ip
      });
    });

    this.expressApp.get('/tpa_config.json', (req: Request, res: Response) => {
      res.json({
        voiceCommands: this.VOICE_COMMANDS.map(phrase => ({
          phrase,
          description: "Check air quality"
        })),
        permissions: ["location"],
        transcriptionLanguages: ["en-US"]
      });
    });

    this.expressApp.post('/webhook', async (req: Request, res: Response) => {
      if (req.body?.type === 'session_request') {
        try {
          await this.createSession({
            sessionId: req.body.sessionId,
            userId: req.body.userId,
            packageName: PACKAGE_NAME
          });
          res.json({ status: 'success' });
        } catch (err) {
          console.error('Session init failed:', err);
          res.status(500).json({ status: 'error' });
        }
      } else {
        res.status(400).json({ status: 'error' });
      }
    });
  }

  private async createSession(params: SessionInitParams): Promise<void> {
    console.log(`Creating session for ${params.userId} with ID ${params.sessionId}`);
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    await super.onSession(session, sessionId, userId);
    this.sessionExtensions.set(sessionId, { locationObtained: false });
    console.log(`New session ${sessionId} started for user ${userId}`);

    session.events.onLocation(async (coords: LocationCoords) => {
      console.log(`📍 Got location: ${coords.lat}, ${coords.lng}`);
      const ext = this.sessionExtensions.get(sessionId);
      if (ext) {
        ext.locationObtained = true;
        ext.lastLocation = { lat: coords.lat, lon: coords.lng };
      }
      await this.showAirQuality(session, coords.lat, coords.lng, false);
    });

    session.events.onTranscription(async (transcript: TranscriptionData) => {
      if (transcript.language === 'en-US') {
        const spoken = transcript.text.toLowerCase();
        console.log(`🎤 Transcribed: "${spoken}"`);
        if (this.VOICE_COMMANDS.some(cmd => spoken.includes(cmd.toLowerCase()))) {
          const ext = this.sessionExtensions.get(sessionId);
          if (ext?.lastLocation) {
            await this.showAirQuality(session, ext.lastLocation.lat, ext.lastLocation.lon, false);
          } else {
            await this.handleAirQualityRequest(session, sessionId);
          }
        }
      }
    });

    setTimeout(() => {
      this.handleAirQualityRequest(session, sessionId).catch(console.error);
    }, 1000);
  }

  private async handleAirQualityRequest(session: TpaSession, sessionId: string): Promise<void> {
    const ext = this.sessionExtensions.get(sessionId);
    if (!ext) return;

    if (ext.lastLocation) {
      return this.showAirQuality(session, ext.lastLocation.lat, ext.lastLocation.lon, false);
    }

    try {
      // Check for Cloudflare geolocation headers
      const geoInfo = await this.getLocationInfo(session);
      if (geoInfo) {
        ext.locationObtained = true;
        ext.lastLocation = geoInfo;
        return this.showAirQuality(session, geoInfo.lat, geoInfo.lon, false);
      }
    } catch (error) {
      console.error('Location fallback failed:', error);
    }

    console.log('⚠️ Falling back to London location');
    await this.showAirQuality(session, 51.5074, -0.1278, true);
  }

  private async getLocationInfo(session: TpaSession): Promise<{ lat: number; lon: number } | null> {
    // Fallback to environment-provided location
    if (process.env.DEFAULT_LAT && process.env.DEFAULT_LON) {
      const lat = parseFloat(process.env.DEFAULT_LAT);
      const lon = parseFloat(process.env.DEFAULT_LON);
      if (!isNaN(lat) && !isNaN(lon)) {
        return { lat, lon };
      }
    }
    
    return null;
  }

  private async showAirQuality(session: TpaSession, lat: number, lon: number, isFallback: boolean): Promise<void> {
    try {
      const station = await this.getNearestAQIStation(lat, lon);
      const quality = AQI_LEVELS.find(level => station.aqi <= level.max) || AQI_LEVELS[AQI_LEVELS.length - 1];

      const locationLine = isFallback
        ? `⚠️ ${station.station.name} (default - device location unavailable)`
        : `📍 ${station.station.name}`;

      const message =
        `${locationLine}\n\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${station.aqi}\n\n` +
        `${quality.advice}`;

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

  private async getNearestAQIStation(lat: number, lon: number): Promise<AQIStationData> {
    try {
      const response = await axios.get(`https://api.waqi.info/feed/geo:${lat};${lon}/?token=${AQI_TOKEN}`, {
        timeout: 5000
      });

      if (response.data.status !== 'ok') {
        throw new Error(response.data.data || 'Station data unavailable');
      }

      const data = response.data.data;
      return {
        aqi: data.aqi,
        station: {
          name: data.city?.name || 'Nearest AQI station',
          geo: data.city?.geo || [lat, lon]
        }
      };
    } catch (error) {
      console.error('AQI station fetch failed:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.expressApp.listen(PORT, () => {
        console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
        resolve();
      }).on('error', (error: Error) => {
        console.error('Failed to start server:', error);
        reject(error);
      });

      process.on('unhandledRejection', (error) => {
        console.error('Unhandled rejection:', error);
      });
    });
  }
}

// Start the server
try {
  const airQualityApp = new AirQualityApp();
  airQualityApp.start();
} catch (error) {
  console.error('Failed to start server:', error);
  process.exit(1);
}