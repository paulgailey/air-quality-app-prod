declare module '@augmentos/sdk' {
    export interface TpaServer {
      // Add methods you use
      onSession: (callback: Function) => void;
    }
    
    export interface TpaSession {
      events: {
        onLocation: (callback: (coords: { lat: number; lng: number }) => void) => void;
        onTranscription: (callback: (data: { text: string }) => void) => void;
      };
      layouts: {
        showTextWall: (text: string, options: any) => Promise<void>;
      };
    }
  
    export enum ViewType {
      MAIN = 'main'
    }
  }