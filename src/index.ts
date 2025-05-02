// Version: 1.3.4
// Fixed util polyfill implementation

// SAFE Polyfill implementation - doesn't modify imports
function setupUtils() {
  const nodeUtil = require('util');
  const { inherits } = nodeUtil;
  
  // Create new util object with inherits
  const customUtil = {
    ...nodeUtil,
    inherits
  };

  // Apply to globalThis if needed
  if (typeof globalThis !== 'undefined') {
    (globalThis as any).util = customUtil;
  }

  return customUtil;
}

// Initialize utils
const util = setupUtils();

// Core dependencies
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { readFileSync } from 'fs';
import axios from 'axios';
import crypto from 'crypto';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';

// Get __dirname for ESM
const __dirname = path.dirname(new URL(import.meta.url).pathname);

// App configuration
const packageJson = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));
const APP_VERSION = packageJson.version;
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
  station: { name: string; geo: [number, number] };
}

interface SessionExtension {
  locationObtained: boolean;
  lastLocation?: { lat: number; lon: number };
}

class AirQualityApp extends TpaServer {
  private readonly VOICE_COMMANDS = [
    "air quality", "what's the air like", "pollution",
    "how clean is the air", "is the air safe",
    "nearest air quality station", "air quality here", "air pollution here"
  ];

  private expressApp: express.Express;
  private sessionExtensions = new Map<string, SessionExtension>();

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
    this.expressApp.use(express.json());

    // Add basic headers
    this.expressApp.use((req, res, next) => {
      req.headers['cf-connecting-ip'] ||= req.ip;
      req.headers['x-device-latitude'] ||= '';
      req.headers['x-device-longitude'] ||= '';
      res.set('X-Request-ID', crypto.randomUUID());
      next();
    });

    this.expressApp.get('/', (req, res) => {
      res.json({
        status: "running",
        version: APP_VERSION,
        endpoints: ['/health', '/tpa_config.json']
      });
    });

    this.expressApp.get('/health', (req, res) => {
      res.json({
        status: "healthy",
        sessions: this.sessionExtensions.size,
        clientIp: req.headers['cf-connecting-ip'] || req.ip
      });
    });

    this.expressApp.get('/tpa_config.json', (req, res) => {
      res.json({
        voiceCommands: this.VOICE_COMMANDS.map(phrase => ({
          phrase,
          description: "Check air quality"
        })),
        permissions: ["location"],
        transcriptionLanguages: ["en-US"]
      });
    });

    this.expressApp.post('/webhook', async (req, res) => {
      if (req.body?.type === 'session_request') {
        try {
          await this.createSession(req.body);
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

  private async createSession({ sessionId, userId }: { sessionId: string; userId: string }): Promise<void> {
    console.log(`Creating session for ${userId} with ID ${sessionId}`);
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    await super.onSession(session, sessionId, userId);
    this.sessionExtensions.set(sessionId, { locationObtained: false });
    console.log(`New session ${sessionId} started for user ${userId}`);

    session.events.onLocation(async coords => {
      console.log(`📍 Got location: ${coords.lat}, ${coords.lon}`);
      const ext = this.sessionExtensions.get(sessionId);
      if (ext) {
        ext.locationObtained = true;
        ext.lastLocation = { lat: coords.lat, lon: coords.lon };
      }
      await this.showAirQuality(session, coords.lat, coords.lon, false);
    });

    session.events.onTranscription(async ({ language, text }) => {
      if (language === 'en-US') {
        const spoken = text.toLowerCase();
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
      const fallbackLoc = await this.getIpLocationFromSession(session);
      if (fallbackLoc) {
        ext.locationObtained = true;
        ext.lastLocation = fallbackLoc;
        return this.showAirQuality(session, fallbackLoc.lat, fallbackLoc.lon, false);
      }
    } catch (error) {
      console.error('Location fallback failed:', error);
    }

    console.log('⚠️ Falling back to London location');
    await this.showAirQuality(session, 51.5074, -0.1278, true);
  }

  private async getIpLocationFromSession(session: TpaSession): Promise<{ lat: number; lon: number } | null> {
    // Implement your IP geolocation logic here
    return null;
  }

  private async showAirQuality(session: TpaSession, lat: number, lon: number, isFallback: boolean): Promise<void> {
    try {
      const station = await this.getNearestAQIStation(lat, lon);
      const quality = AQI_LEVELS.find(level => station.aqi <= level.max) || AQI_LEVELS.at(-1)!;

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

      process.on('unhandledRejection', error => {
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