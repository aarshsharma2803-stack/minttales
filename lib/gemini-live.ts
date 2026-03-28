// Client-side only — WebSocket to Google Live API

const LIVE_WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private _systemInstruction: string;
  private onText: (text: string) => void;
  private onReady: () => void;
  private onClose: () => void;

  constructor(opts: {
    systemInstruction: string;
    onText: (text: string) => void;
    onReady?: () => void;
    onClose?: () => void;
  }) {
    this._systemInstruction = opts.systemInstruction;
    this.onText = opts.onText;
    this.onReady = opts.onReady ?? (() => {});
    this.onClose = opts.onClose ?? (() => {});
  }

  connect(apiKey: string) {
    this.ws = new WebSocket(`${LIVE_WS_URL}?key=${apiKey}`);

    this.ws.onopen = () => {
      this.ws!.send(JSON.stringify({
        setup: {
          model: "models/gemini-3.1-flash-live-preview",
          systemInstruction: {
            parts: [{ text: this._systemInstruction }],
          },
          generationConfig: { responseModalities: ["TEXT"] },
        },
      }));
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.setupComplete) { this.onReady(); return; }
        const parts = data.serverContent?.modelTurn?.parts ?? [];
        for (const part of parts) {
          if (part.text) this.onText(part.text);
        }
      } catch { /* ignore parse errors */ }
    };

    this.ws.onerror = (e) => console.error("Live API WS error:", e);
    this.ws.onclose = () => this.onClose();
  }

  send(text: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    }));
  }

  sendAudio(pcmBase64: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      realtimeInput: {
        mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcmBase64 }],
      },
    }));
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

export function createDirectorClient(opts: {
  onText: (text: string) => void;
  onReady?: () => void;
}): GeminiLiveClient {
  return new GeminiLiveClient({
    systemInstruction: `You are an enthusiastic AI film director watching a story come to life as videos generate in real time. When given a status update about video generation, respond with 2-3 sentences of exciting cinematic commentary. Be specific, build anticipation. Never ask questions. No markdown.`,
    onText: opts.onText,
    onReady: opts.onReady,
  });
}

export function createVoiceClient(opts: {
  onTranscript: (text: string) => void;
  onReady?: () => void;
}): GeminiLiveClient {
  return new GeminiLiveClient({
    systemInstruction: "Transcribe the user's speech exactly. Return only the transcribed words, nothing else.",
    onText: opts.onTranscript,
    onReady: opts.onReady,
  });
}
