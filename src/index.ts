import 'dotenv/config';
import express from 'express';
import path from 'path';
import { TpaServer, TpaSession, ViewType, StreamType } from '@augmentos/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { readFileSync } from 'fs';

// Configuration
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
);
const APP_VERSION = packageJson.version;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.everywoah.airquality';
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

class AirQualityApp extends TpaServer {
  private activeSessions = new Map<string, { 
    userId: string; 
    started: Date;
    locationAttempted: boolean;
    locationObtained: boolean;
  }>();
  private requestCount = 0;

  private readonly VOICE_COMMANDS = [
    "air quality",
    "what's the air like",
    "pollution",
    "how clean is the air",
    "is the air safe",
    "nearest air quality station"
  ];

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: AUGMENTOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, '../public'),
    });
    this.setupRoutes();
  }

  private setupRoutes(): void {
    const app = this.getExpressApp();

    // Middleware
    app.use((req, res, next) => {
      this.requestCount++;
      const requestId = crypto.randomUUID();
      res.set('X-Request-ID', requestId);
      console.log(`[${new Date().toISOString()}] REQ#${this.requestCount} ${req.method} ${req.path}`);
      next();
    });
    app.use(express.json());

    // Routes
    app.get('/', (req, res) => {
      res.json({
        status: "running",
        version: APP_VERSION,
        endpoints: ['/health', '/tpa_config.json']
      });
    });

    app.get('/health', (req, res) => {
      res.json({
        status: "healthy",
        sessions: this.activeSessions.size
      });
    });

    app.get('/tpa_config.json', (req, res) => {
      res.json({
        voiceCommands: this.VOICE_COMMANDS.map(phrase => ({
          phrase,
          description: "Check air quality"
        })),
        permissions: ["location"],
        transcriptionLanguages: ["en-US"]
      });
    });

    app.post('/webhook', async (req, res) => {
      if (req.body?.type === 'session_request') {
        try {
          await this.initTpaSession({
            sessionId: req.body.sessionId,
            userId: req.body.userId,
            packageName: PACKAGE_NAME
          });
          console.log(`Session initialized: ${req.body.sessionId} for user ${req.body.userId}`);
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
    this.activeSessions.set(sessionId, { 
      userId, 
      started: new Date(),
      locationAttempted: false,
      locationObtained: false
    });

    console.log(`New session ${sessionId} started for user ${userId}`);
    
    // Explicitly request location
    try {
      const sessionData = this.activeSessions.get(sessionId);
      if (sessionData) {
        sessionData.locationAttempted = true;
      }
      await session.requestLocation();
      console.log(`Location requested for session ${sessionId}`);
    } catch (error) {
      console.error(`Failed to request location for session ${sessionId}:`, error);
    }

    // 🔍 PRIORITY: SDK location callback
    session.events.onLocation(async (coords) => {
      console.log(`📍 Received coordinates from SDK: ${coords.lat}, ${coords.lon}`);
      const sessionData = this.activeSessions.get(sessionId);
      if (sessionData) {
        sessionData.locationObtained = true;
      }
      await this.checkAirQuality(session, coords.lat, coords.lon);
    });

    // 🎤 Voice command trigger
    session.onTranscriptionForLanguage('en-US', (transcript) => {
      const text = transcript.text.toLowerCase();
      console.log(`🎤 Heard: "${text}" for session ${sessionId}`);
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        this.checkAirQuality(session).catch(console.error);
      }
    });

    // First fallback: Check if session has location after a delay
    setTimeout(async () => {
      const sessionData = this.activeSessions.get(sessionId);
      if (sessionData && !sessionData.locationObtained && session.location?.latitude) {
        console.log(`📍 Using session.location after delay for ${sessionId}: ${session.location.latitude}, ${session.location.longitude}`);
        sessionData.locationObtained = true;
        await this.checkAirQuality(session, session.location.latitude, session.location.longitude);
      }
    }, 1500);

    // Second fallback: Try browser IP location if SDK location fails
    setTimeout(async () => {
      const sessionData = this.activeSessions.get(sessionId);
      if (sessionData && !sessionData.locationObtained) {
        console.log(`📍 No SDK location detected for ${sessionId}, trying IP geolocation...`);
        try {
          const ipLocation = await this.getIpBasedLocation(session.request?.ip);
          console.log(`📍 IP location for ${sessionId}: ${ipLocation.lat}, ${ipLocation.lon}`);
          await this.checkAirQuality(session, ipLocation.lat, ipLocation.lon);
          sessionData.locationObtained = true;
        } catch (error) {
          console.error(`IP geolocation failed for ${sessionId}:`, error);
          // Last resort fallback
          console.log(`📍 Using default location for ${sessionId}`);
          await this.checkAirQuality(session, 51.5074, -0.1278);
        }
      }
    }, 3000);
  }

  private async getNearestAQIStation(lat: number, lon: number): Promise<AQIStationData> {
    try {
      console.log(`Fetching AQI data for coordinates: ${lat}, ${lon}`);
      const response = await axios.get(
        `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${AQI_TOKEN}`,
        { timeout: 5000 } // Increased timeout
      );
      if (response.data.status !== 'ok') {
        throw new Error(response.data.data || 'Station data unavailable');
      }
      console.log(`AQI data received: ${response.data.data.aqi} from ${response.data.data.city?.name || 'Unknown station'}`);
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

  private async checkAirQuality(session: TpaSession, lat?: number, lon?: number): Promise<void> {
    try {
      console.log(`CheckAirQuality called with lat: ${lat}, lon: ${lon}`);
      let coords;
      
      if (lat && lon) {
        coords = { lat, lon };
        console.log(`Using provided coordinates: ${lat}, ${lon}`);
      } else if (session.location?.latitude && session.location?.longitude) {
        coords = { lat: session.location.latitude, lon: session.location.longitude };
        console.log(`Using session.location: ${coords.lat}, ${coords.lon}`);
      } else {
        coords = await this.getIpBasedLocation(session.request?.ip);
        console.log(`Using IP-based location: ${coords.lat}, ${coords.lon}`);
      }

      const station = await this.getNearestAQIStation(coords.lat, coords.lon);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];

      await session.layouts.showTextWall(
        `📍 ${station.station.name}\n\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${station.aqi}\n\n` +
        `${quality.advice}`,
        { view: ViewType.MAIN, durationMs: 15000 } // Increased display time
      );
    } catch (error) {
      console.error("Check failed:", error);
      await session.layouts.showTextWall("Air quality unavailable. Please try again.", { 
        view: ViewType.MAIN,
        durationMs: 5000 
      });
    }
  }

  private async getIpBasedLocation(ip?: string): Promise<{ lat: number, lon: number }> {
    try {
      // If we have the client IP, use it
      if (ip && ip !== '127.0.0.1' && ip !== 'localhost') {
        console.log(`Attempting geolocation for IP: ${ip}`);
        const ipLocation = await axios.get(`https://ipapi.co/${ip}/json/`, { timeout: 3000 });
        if (ipLocation.data.latitude && ipLocation.data.longitude) {
          return { lat: ipLocation.data.latitude, lon: ipLocation.data.longitude };
        }
      }
      
      // Try to get server IP location
      console.log(`Attempting geolocation for server IP`);
      const serverIp = await axios.get('https://ipapi.co/json/', { timeout: 3000 });
      if (serverIp.data.latitude && serverIp.data.longitude) {
        return { lat: serverIp.data.latitude, lon: serverIp.data.longitude };
      }
    } catch (error) {
      console.warn("IP geolocation failed:", error);
    }
    
    console.log("IP geolocation failed, falling back to default location");
    return { lat: 51.5074, lon: -0.1278 }; // London fallback
  }
}

new AirQualityApp().getExpressApp().listen(PORT, () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
});