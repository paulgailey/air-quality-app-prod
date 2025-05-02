// Version: 1.3.2
// Complete implementation with proper TpaSession typing

// Polyfill implementation
import * as util from 'util';
import { inherits as inheritsFn } from 'util';

const enhancedUtil = {
  ...util,
  inherits: inheritsFn
};

if (typeof globalThis !== 'undefined') {
  (globalThis as any).util = enhancedUtil;
}

// Core imports
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { readFileSync } from 'fs';

// Get __dirname equivalent
const __dirname = path.dirname(new URL(import.meta.url).pathname);

// Configuration
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
);
const APP_VERSION = packageJson.version;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'air-quality-app';
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY || '';
const AQI_TOKEN = process.env.AQI_TOKEN || '';

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
      publicDir: path.join(__dirname, '../public')
    });

    this.expressApp = express();
    this.expressApp.set('trust proxy', true);
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.expressApp.use((req: Request, res: Response, next: NextFunction) => {
      req.headers['cf-connecting-ip'] = req.headers['cf-connecting-ip'] || req.ip;
      req.headers['x-device-latitude'] = req.headers['x-device-latitude'] || '';
      req.headers['x-device-longitude'] = req.headers['x-device-longitude'] || '';
      res.set('X-Request-ID', crypto.randomUUID());
      next();
    });
    this.expressApp.use(express.json());

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
        } catch (error) {
          console.error('Session init failed:', error);
          res.status(500).json({ status: 'error' });
        }
      } else {
        res.status(400).json({ status: 'error' });
      }
    });
  }

  private async createSession(params: { sessionId: string; userId: string; packageName: string }): Promise<void> {
    console.log(`Creating session for ${params.userId} with ID ${params.sessionId}`);
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

    session.events.onTranscription(async (transcript) => {
      if (transcript.language === 'en-US') {
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
      await this.showAirQuality(session, ext.lastLocation.lat, ext.lastLocation.lon, false);
      return;
    }

    try {
      // Fallback to IP geolocation if no direct location available
      const ipLocation = await this.getIpLocationFromSession(session);
      if (ipLocation) {
        console.log(`📍 Using IP geolocation: ${ipLocation.lat}, ${ipLocation.lon}`);
        ext.locationObtained = true;
        ext.lastLocation = ipLocation;
        await this.showAirQuality(session, ipLocation.lat, ipLocation.lon, false);
        return;
      }
    } catch (error) {
      console.error('Location fallback failed:', error);
    }

    console.log('⚠️ Using default London location');
    await this.showAirQuality(session, 51.5074, -0.1278, true);
  }

  private async getIpLocationFromSession(session: TpaSession): Promise<{ lat: number; lon: number } | null> {
    // Implement your actual IP geolocation logic here
    // This is just a placeholder fallback
    return null;
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

  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.expressApp.listen(PORT, () => {
        console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
        resolve();
      }).on('error', (error) => {
        console.error('Failed to start server:', error);
        reject(error);
      });

      process.on('unhandledRejection', (error) => {
        console.error('Unhandled rejection:', error);
      });

      process.on('uncaughtException', (error) => {
        console.error('Uncaught exception:', error);
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