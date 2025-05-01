// Version: 1.2.4
// Description: Air Quality Augmentos App - Cloudflare Optimized
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { readFileSync } from 'fs';

// Configuration
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
);
const APP_VERSION = packageJson.version;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'air-quality-app';
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY;
const AQI_TOKEN = process.env.AQI_TOKEN;

// Validate environment
if (!AUGMENTOS_API_KEY || !AQI_TOKEN) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

// AQI Levels
const AQI_LEVELS = [
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

class AirQualityApp extends TpaServer {
  private readonly VOICE_COMMANDS = [
    "air quality",
    "what's the air like",
    "pollution",
    "how clean is the air",
    "is the air safe",
    "nearest air quality station",
    "air quality here",
    "air pollution here"
  ];

  private sessionExtensions = new Map<string, SessionExtension>();
  private expressApp: express.Express;

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: AUGMENTOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, '../public'),
      augmentOSWebsocketUrl: process.env.AUGMENTOS_WEBSOCKET_URL || 'wss://prod.augmentos.cloud/tpa-ws',
      websocket: {
        reconnect: true,
        timeout: 15000
      },
      trustProxy: true
    });

    this.expressApp = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Enhanced Cloudflare middleware
    this.expressApp.use((req: Request, res: Response, next: NextFunction) => {
      req.headers['cf-connecting-ip'] = req.headers['cf-connecting-ip'] || req.ip;
      req.headers['x-device-latitude'] = req.headers['x-device-latitude'] || '';
      req.headers['x-device-longitude'] = req.headers['x-device-longitude'] || '';
      res.set('X-Request-ID', crypto.randomUUID());
      next();
    });
    this.expressApp.use(express.json());

    // Routes
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
          await this.initSession({
            sessionId: req.body.sessionId,
            userId: req.body.userId,
            packageName: PACKAGE_NAME
          });
          res.json({ status: 'success' });
        } catch (error) {
          console.error('Session init failed:', error);
          res.status(500).json({ status: 'error' });
        }
      } else {
        res.status(400).json({ status: 'error' });
      }
    });
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    await super.onSession(session, sessionId, userId);
    this.sessionExtensions.set(sessionId, {
      locationObtained: false
    });

    console.log(`New session ${sessionId} started for user ${userId}`);

    session.events.onLocation(async (coords) => {
      console.log(`📍 Received coordinates from SDK: ${coords.lat}, ${coords.lon}`);
      const ext = this.sessionExtensions.get(sessionId);
      if (ext) {
        ext.locationObtained = true;
        ext.lastLocation = { lat: coords.lat, lon: coords.lon };
      }
      await this.showAirQuality(session, coords.lat, coords.lon, false);
    });

    session.onTranscriptionForLanguage('en-US', async (transcript) => {
      const text = transcript.text.toLowerCase();
      console.log(`🎤 Heard: "${text}" for session ${sessionId}`);
      
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        const ext = this.sessionExtensions.get(sessionId);
        if (ext?.lastLocation) {
          await this.showAirQuality(session, ext.lastLocation.lat, ext.lastLocation.lon, false);
        } else {
          await this.handleAirQualityRequest(session, sessionId);
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

    if (session.location?.latitude && session.location?.longitude) {
      console.log(`📍 Using session.location: ${session.location.latitude}, ${session.location.longitude}`);
      ext.locationObtained = true;
      ext.lastLocation = {
        lat: session.location.latitude,
        lon: session.location.longitude
      };
      await this.showAirQuality(session, session.location.latitude, session.location.longitude, false);
      return;
    }

    try {
      const clientIp = this.getClientIp(session);
      if (clientIp) {
        const ipLocation = await this.getIpLocation(clientIp);
        console.log(`📍 Using client IP location: ${ipLocation.lat}, ${ipLocation.lon}`);
        ext.locationObtained = true;
        ext.lastLocation = ipLocation;
        await this.showAirQuality(session, ipLocation.lat, ipLocation.lon, false);
        return;
      }
    } catch (error) {
      console.error('Client IP geolocation failed:', error);
    }

    console.log('⚠️ Using default London location');
    await this.showAirQuality(session, 51.5074, -0.1278, true);
  }

  private async showAirQuality(session: TpaSession, lat: number, lon: number, isFallback: boolean): Promise<void> {
    try {
      const station = await this.getNearestAQIStation(lat, lon);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      let locationMessage = `📍 ${station.station.name}`;
      if (isFallback) {
        locationMessage = `⚠️ ${station.station.name} (default - device location unavailable)`;
      }

      await session.layouts.showTextWall(
        `${locationMessage}\n\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${station.aqi}\n\n` +
        `${quality.advice}`,
        { view: ViewType.MAIN, durationMs: 15000 }
      );
    } catch (error) {
      console.error("Air quality check failed:", error);
      await session.layouts.showTextWall(
        "⚠️ Couldn't retrieve air quality data. Please try again later.",
        { view: ViewType.MAIN, durationMs: 5000 }
      );
    }
  }

  private getClientIp(session: TpaSession): string | null {
    if (!session.request?.headers) return null;
    const headers = session.request.headers;
    
    if (headers['cf-connecting-ip']) {
      return headers['cf-connecting-ip'] as string;
    }

    const xForwardedFor = headers['x-forwarded-for'];
    if (xForwardedFor) {
      return (Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor).split(',')[0].trim();
    }

    return headers['x-real-ip'] as string || null;
  }

  private async getIpLocation(ip: string): Promise<{ lat: number; lon: number }> {
    try {
      const response = await axios.get(`https://ipapi.co/${ip}/json/`, { timeout: 3000 });
      if (response.data.latitude && response.data.longitude) {
        return {
          lat: response.data.latitude,
          lon: response.data.longitude
        };
      }
      
      const fallbackResponse = await axios.get(`http://ip-api.com/json/${ip}`, { timeout: 3000 });
      if (fallbackResponse.data.lat && fallbackResponse.data.lon) {
        return {
          lat: fallbackResponse.data.lat,
          lon: fallbackResponse.data.lon
        };
      }
      
      throw new Error('No location data from geolocation services');
    } catch (error) {
      console.error('IP geolocation failed:', error);
      throw error;
    }
  }

  private async getNearestAQIStation(lat: number, lon: number): Promise<AQIStationData> {
    try {
      const response = await axios.get(
        `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${AQI_TOKEN}`,
        { timeout: 5000 }
      );
      
      if (response.data.status !== 'ok') {
        throw new Error(response.data.data || 'Station data unavailable');
      }
      
      return {
        aqi: response.data.data.aqi,
        station: {
          name: response.data.data.city?.name || 'Nearest AQI station',
          geo: response.data.data.city?.geo || [lat, lon]
        }
      };
    } catch (error) {
      console.error('AQI station fetch failed:', error);
      throw error;
    }
  }

  public start(): void {
    this.expressApp.listen(PORT, () => {
      console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
    });
  }
}

// Start the server
const airQualityApp = new AirQualityApp();
airQualityApp.start();