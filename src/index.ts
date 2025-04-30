// Version: 1.2.1
// Description: Air Quality Augmentos App - Fixed Location Handling
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
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
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
    locationObtained: boolean;
    lastLocation?: { lat: number; lon: number };
  }>();

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
      res.set('X-Request-ID', crypto.randomUUID());
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
      locationObtained: false
    });

    console.log(`New session ${sessionId} started for user ${userId}`);

    // 🔍 PRIORITY: SDK location callback
    session.events.onLocation(async (coords) => {
      console.log(`📍 Received coordinates from SDK: ${coords.lat}, ${coords.lon}`);
      const sessionData = this.activeSessions.get(sessionId);
      if (sessionData) {
        sessionData.locationObtained = true;
        sessionData.lastLocation = { lat: coords.lat, lon: coords.lon };
      }
      await this.showAirQuality(session, coords.lat, coords.lon, false);
    });

    // 🎤 Voice command trigger
    session.onTranscriptionForLanguage('en-US', async (transcript) => {
      const text = transcript.text.toLowerCase();
      console.log(`🎤 Heard: "${text}" for session ${sessionId}`);
      
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        const sessionData = this.activeSessions.get(sessionId);
        if (sessionData?.lastLocation) {
          // Use last known location if available
          await this.showAirQuality(
            session, 
            sessionData.lastLocation.lat, 
            sessionData.lastLocation.lon, 
            false
          );
        } else {
          // Try to get fresh location
          await this.handleAirQualityRequest(session, sessionId);
        }
      }
    });

    // Initial location attempt
    setTimeout(() => {
      this.handleAirQualityRequest(session, sessionId).catch(console.error);
    }, 1000);
  }

  private async handleAirQualityRequest(session: TpaSession, sessionId: string): Promise<void> {
    const sessionData = this.activeSessions.get(sessionId);
    if (!sessionData) return;

    // 1. First try session.location if available
    if (session.location?.latitude && session.location?.longitude) {
      console.log(`📍 Using session.location: ${session.location.latitude}, ${session.location.longitude}`);
      sessionData.locationObtained = true;
      sessionData.lastLocation = {
        lat: session.location.latitude,
        lon: session.location.longitude
      };
      await this.showAirQuality(
        session, 
        session.location.latitude, 
        session.location.longitude, 
        false
      );
      return;
    }

    // 2. Try client IP geolocation (respecting Fly.io headers)
    try {
      const clientIp = this.getClientIp(session);
      if (clientIp) {
        const ipLocation = await this.getIpLocation(clientIp);
        console.log(`📍 Using client IP location: ${ipLocation.lat}, ${ipLocation.lon}`);
        sessionData.locationObtained = true;
        sessionData.lastLocation = ipLocation;
        await this.showAirQuality(session, ipLocation.lat, ipLocation.lon, false);
        return;
      }
    } catch (error) {
      console.error('Client IP geolocation failed:', error);
    }

    // 3. Final fallback with warning
    console.log('⚠️ Using default London location');
    await this.showAirQuality(session, 51.5074, -0.1278, true);
  }

  private async showAirQuality(session: TpaSession, lat: number, lon: number, isFallback: boolean): Promise<void> {
    try {
      const station = await this.getNearestAQIStation(lat, lon);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      let locationMessage = `📍 ${station.station.name}`;
      if (isFallback) {
        locationMessage = `⚠️ ${station.station.name} (default location - enable GPS for accurate results)`;
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
    
    // Fly.io headers take priority
    if (headers['fly-client-ip']) {
      return headers['fly-client-ip'] as string;
    }

    // Standard headers
    const xForwardedFor = headers['x-forwarded-for'];
    if (xForwardedFor) {
      return (Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor).split(',')[0].trim();
    }

    return headers['x-real-ip'] as string || null;
  }

  private async getIpLocation(ip: string): Promise<{ lat: number; lon: number }> {
    try {
      // First try ipapi.co
      const response = await axios.get(`https://ipapi.co/${ip}/json/`, { timeout: 3000 });
      if (response.data.latitude && response.data.longitude) {
        return {
          lat: response.data.latitude,
          lon: response.data.longitude
        };
      }
      
      // Fallback to ip-api.com if ipapi fails
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
}

new AirQualityApp().getExpressApp().listen(PORT, () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
});