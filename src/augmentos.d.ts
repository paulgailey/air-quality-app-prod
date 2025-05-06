// src/augmentos.d.ts
declare module '@augmentos/sdk' {
    export class TpaServer {
      constructor(config: { packageName: string; apiKey: string });
      // Add any methods you use
    }
  
    export class TpaSession {
      events: {
        onLocation: (callback: (coords: { lat: number; lng: number }) => void) => void;
        onTranscription: (callback: (data: { text: string; language?: string }) => void) => void;
      };
      layouts: {
        showTextWall: (text: string, options: { view: ViewType; durationMs: number }) => Promise<void>;
      };
    }
  
    export enum ViewType {
      MAIN = 'main',
      SECONDARY = 'secondary'
    }
  }