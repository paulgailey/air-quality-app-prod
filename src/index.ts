// Version: 1.0.1
// Description: Air Quality Augmentos App
import 'dotenv/config';
import express from 'express';
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
    
    // Request location immediately
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
      await this.showAirQuality(session, coords.lat, coords.lon, false);
    });

    // 🎤 Voice command trigger
    session.onTranscriptionForLanguage('en-US', (transcript) => {
      const text = transcript.text.toLowerCase();
      console.log(`🎤 Heard: "${text}" for session ${sessionId}`);
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        this.handleAirQualityRequest(session, sessionId).catch(console.error);
      }
    });

    // Fallback: Check if session has location after a delay
    setTimeout(async () => {
      await this.handleAirQualityRequest(session, sessionId);
    }, 2000);
  }

  private async handleAirQualityRequest(session: TpaSession, sessionId: string): Promise<void> {
    const sessionData = this.activeSessions.get(sessionId);
    if (!sessionData) return;

    // If we already have location from SDK callback, skip
    if (sessionData.locationObtained) return;

    // Check if we have session location
    if (session.location?.latitude && session.location?.longitude) {
      console.log(`📍 Using session.location for ${sessionId}: ${session.location.latitude}, ${session.location.longitude}`);
      sessionData.locationObtained = true;
      await this.showAirQuality(session, session.location.latitude, session.location.longitude, false);
      return;
    }

    // Try IP-based location
    try {
      const ipLocation = await this.getIpBasedLocation(session);
      console.log(`📍 Using IP-based location for ${sessionId}: ${ipLocation.lat}, ${ipLocation.lon}`);
      await this.showAirQuality(session, ipLocation.lat, ipLocation.lon, false);
      sessionData.locationObtained = true;
    } catch (error) {
      console.error(`IP/header geolocation failed for ${sessionId}:`, error);
      // Final fallback to London with warning
      console.log(`📍 Using default location for ${sessionId}`);
      await this.showAirQuality(session, 51.5074, -0.1278, true);
    }
  }

  private async getNearestAQIStation(lat: number, lon: number): Promise<AQIStationData> {
    try {
      console.log(`Fetching AQI data for coordinates: ${lat}, ${lon}`);
      const response = await axios.get(
        `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${AQI_TOKEN}`,
        { timeout: 5000 }
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

  private async showAirQuality(session: TpaSession, lat: number, lon: number, isFallback: boolean): Promise<void> {
    try {
      const station = await this.getNearestAQIStation(lat, lon);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      let locationMessage = `📍 ${station.station.name}`;
      if (isFallback) {
        locationMessage += "\n⚠️ Using default location (couldn't detect yours)";
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

  private async getIpBasedLocation(session: TpaSession): Promise<{ lat: number, lon: number }> {
    try {
      // Check for Fly.io geolocation headers first
      if (session.request?.headers) {
        const headers = session.request.headers;
        
        // Fly.io specific geo headers
        if (headers['fly-geo-lat'] && headers['fly-geo-long']) {
          const lat = parseFloat(headers['fly-geo-lat']);
          const lon = parseFloat(headers['fly-geo-long']);
          console.log(`Using Fly.io geo headers: ${lat}, ${lon}`);
          return { lat, lon };
        }
        
        // Get client IP from headers
        const clientIp = headers['fly-client-ip'] || 
                        headers['x-forwarded-for']?.split(',')[0] || 
                        headers['x-real-ip'];
        
        if (clientIp && !['127.0.0.1', 'localhost'].includes(clientIp)) {
          console.log(`Attempting IP geolocation for: ${clientIp}`);
          const ipLocation = await axios.get(`https://ipapi.co/${clientIp}/json/`, { timeout: 3000 });
          if (ipLocation.data.latitude && ipLocation.data.longitude) {
            return { 
              lat: ipLocation.data.latitude, 
              lon: ipLocation.data.longitude 
            };
          }
        }
      }
      
      // Last resort: server IP location
      console.log(`Falling back to server IP geolocation`);
      const serverIp = await axios.get('https://ipapi.co/json/', { timeout: 3000 });
      if (serverIp.data.latitude && serverIp.data.longitude) {
        return { 
          lat: serverIp.data.latitude, 
          lon: serverIp.data.longitude 
        };
      }
    } catch (error) {
      console.warn("IP geolocation failed:", error);
      throw error;
    }
    
    throw new Error("All geolocation methods failed");
  }
}

new AirQualityApp().getExpressApp().listen(PORT, () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
});