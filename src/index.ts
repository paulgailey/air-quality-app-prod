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
    
    // Explicitly request location using the SDK method
    try {
      const sessionData = this.activeSessions.get(sessionId);
      if (sessionData) {
        sessionData.locationAttempted = true;
      }
      console.log(`Requesting location for session ${sessionId}`);
      await session.requestLocation();
      console.log(`Location request sent for session ${sessionId}`);
    } catch (error) {
      console.error(`Failed to request location for session ${sessionId}:`, error);
    }

    // Add app-specific metadata to help with debugging
    await session.setMetadata({
      app_version: APP_VERSION,
      location_requested: true,
      server_region: process.env.FLY_REGION || "unknown"
    });
    
    // Log useful debugging info
    console.log(`Session info - has location: ${!!session.location}`);
    if (session.location) {
      console.log(`Initial location data: ${session.location.latitude}, ${session.location.longitude}`);
    }
    if (session.request?.headers) {
      console.log(`Headers preview: ${JSON.stringify(Object.keys(session.request.headers).slice(0, 10))}`);
    }

    // 🔍 PRIORITY 1: SDK location callback
    session.events.onLocation(async (coords) => {
      console.log(`📍 PRIORITY 1: Received coordinates from SDK: ${coords.lat}, ${coords.lon}`);
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

    // PRIORITY 2: Check if session has location after a short delay
    setTimeout(async () => {
      const sessionData = this.activeSessions.get(sessionId);
      if (sessionData && !sessionData.locationObtained && session.location?.latitude) {
        console.log(`📍 PRIORITY 2: Using session.location after delay for ${sessionId}: ${session.location.latitude}, ${session.location.longitude}`);
        sessionData.locationObtained = true;
        await this.checkAirQuality(session, session.location.latitude, session.location.longitude);
      } else {
        console.log(`No session.location available for ${sessionId} after initial delay`);
        // Try refreshing session object to see if location is available
        try {
          console.log("Attempting to refresh session data...");
          const refreshedSession = await this.getSession(sessionId);
          if (refreshedSession && refreshedSession.location?.latitude) {
            console.log(`📍 Using refreshed session location: ${refreshedSession.location.latitude}, ${refreshedSession.location.longitude}`);
            if (sessionData) sessionData.locationObtained = true;
            await this.checkAirQuality(session, refreshedSession.location.latitude, refreshedSession.location.longitude);
            return;
          }
        } catch (err) {
          console.log(`Session refresh attempt failed: ${err.message}`);
        }
      }
    }, 1500);

    // PRIORITY 3: Try headers & IP location if SDK location fails
    setTimeout(async () => {
      const sessionData = this.activeSessions.get(sessionId);
      if (sessionData && !sessionData.locationObtained) {
        console.log(`📍 PRIORITY 3: No SDK location detected for ${sessionId}, trying header/IP geolocation...`);
        try {
          const ipLocation = await this.getIpBasedLocation(session);
          console.log(`📍 IP/header location for ${sessionId}: ${ipLocation.lat}, ${ipLocation.lon}`);
          await this.checkAirQuality(session, ipLocation.lat, ipLocation.lon);
          sessionData.locationObtained = true;
        } catch (error) {
          console.error(`IP/header geolocation failed for ${sessionId}:`, error);
          // Last resort fallback
          console.log(`📍 PRIORITY 4: Using default location for ${sessionId}`);
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
        coords = await this.getIpBasedLocation(session);
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

  private async getIpBasedLocation(session: TpaSession): Promise<{ lat: number, lon: number }> {
    try {
      // Check for Fly.io geolocation headers first
      if (session.request?.headers) {
        const headers = session.request.headers;
        console.log("Request headers available:", JSON.stringify(headers, null, 2));
        
        // Try various geo headers that CDNs and proxies might set
        const geoHeaders = [
          { lat: headers['fly-geo-lat'], lon: headers['fly-geo-long'] },
          { lat: headers['x-vercel-ip-latitude'], lon: headers['x-vercel-ip-longitude'] },
          { lat: headers['x-appengine-citylatlong']?.split(',')[0], lon: headers['x-appengine-citylatlong']?.split(',')[1] },
          { lat: headers['cf-iplatitude'], lon: headers['cf-iplongitude'] }
        ];
        
        for (const geo of geoHeaders) {
          if (geo.lat && geo.lon) {
            const lat = parseFloat(geo.lat);
            const lon = parseFloat(geo.lon);
            if (!isNaN(lat) && !isNaN(lon)) {
              console.log(`Using geo headers: ${lat}, ${lon}`);
              return { lat, lon };
            }
          }
        }
        
        // Get real client IP from Fly headers
        const clientIp = headers['fly-client-ip'] || 
                        headers['x-forwarded-for'] || 
                        headers['x-real-ip'] ||
                        session.request?.ip;
                        
        if (clientIp && clientIp !== '127.0.0.1' && clientIp !== 'localhost') {
          console.log(`Attempting geolocation for client IP: ${clientIp}`);
          try {
            const ipLocation = await axios.get(`https://ipapi.co/${clientIp}/json/`, { timeout: 3000 });
            if (ipLocation.data.latitude && ipLocation.data.longitude) {
              return { lat: ipLocation.data.latitude, lon: ipLocation.data.longitude };
            }
          } catch (ipError) {
            console.log(`IP lookup failed for ${clientIp}: ${ipError.message}`);
          }
        }
      }
      
      // Try to get server IP location as last resort
      console.log(`Attempting geolocation for server IP`);
      const serverIp = await axios.get('https://ipapi.co/json/', { timeout: 3000 });
      if (serverIp.data.latitude && serverIp.data.longitude) {
        return { lat: serverIp.data.latitude, lon: serverIp.data.longitude };
      }
    } catch (error) {
      console.warn(`IP geolocation failed: ${error.message}`);
    }
    
    console.log("All geolocation methods failed, falling back to default location");
    return { lat: 51.5074, lon: -0.1278 }; // London fallback
  }
}

new AirQualityApp().getExpressApp().listen(PORT, () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
});