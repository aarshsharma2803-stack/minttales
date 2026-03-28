"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

const WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";
const MODEL = "models/gemini-2.5-flash-native-audio-latest";
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

interface Message { role: "user" | "ai"; text: string; }

interface LiveVoiceAssistantProps {
  apiKey: string;
  genre: string;
  storyContext?: string;
  onSuggestion?: (text: string) => void;
  /** When true, always visible as site-wide floating button */
  siteWide?: boolean;
}

function pcmBase64ToAudioBuffer(b64: string, ctx: AudioContext): AudioBuffer {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const samples = bytes.length / 2;
  const buf = ctx.createBuffer(1, samples, OUTPUT_SAMPLE_RATE);
  const ch = buf.getChannelData(0);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
  return buf;
}

export default function LiveVoiceAssistant({ apiKey, genre, storyContext, onSuggestion, siteWide }: LiveVoiceAssistantProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "connecting" | "ready" | "listening" | "thinking" | "speaking" | "error">("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isMicOn, setIsMicOn] = useState(false);
  const [currentAiText, setCurrentAiText] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [textInput, setTextInput] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const aiTextBufRef = useRef("");
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentAiText]);

  const scheduleAudioPlayback = useCallback((b64: string) => {
    if (!audioCtxRef.current) return;
    try {
      const buf = pcmBase64ToAudioBuffer(b64, audioCtxRef.current);
      const src = audioCtxRef.current.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtxRef.current.destination);
      const now = audioCtxRef.current.currentTime;
      if (nextPlayTimeRef.current < now) nextPlayTimeRef.current = now + 0.05;
      src.start(nextPlayTimeRef.current);
      nextPlayTimeRef.current += buf.duration;
      setStatus("speaking");
    } catch (e) {
      console.error("Audio playback error:", e);
    }
  }, []);

  const getSystemInstruction = useCallback(() => {
    if (siteWide || !storyContext || storyContext.length < 50) {
      return `You are MintBot, a helpful 24/7 AI assistant for MintTales — a platform where users create AI-generated ${genre} stories, cinematic videos with Veo 2, and mint them as NFTs on Solana. Help users with story creation, video generation, NFT minting, and anything else on the platform. Keep responses short and friendly (2-3 sentences max). Current context: ${storyContext?.slice(0, 300) || "home page"}.`;
    }
    return `You are a creative AI co-author helping craft a ${genre} story. The user will speak their ideas and you respond with enthusiastic, concise suggestions (2-3 sentences max). Keep responses short and punchy. Current story context: ${storyContext.slice(0, 400)}.`;
  }, [genre, storyContext, siteWide]);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    processorRef.current?.disconnect();
    processorRef.current = null;
    mediaStreamRef.current?.getTracks().forEach(t => t.stop());
    mediaStreamRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setStatus("idle");
    setIsMicOn(false);
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current) return;
    if (!apiKey) {
      setErrorMsg("No API key configured");
      setStatus("error");
      return;
    }
    setStatus("connecting");
    setErrorMsg("");
    aiTextBufRef.current = "";

    audioCtxRef.current = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    nextPlayTimeRef.current = 0;

    const ws = new WebSocket(`${WS_URL}?key=${apiKey}`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model: MODEL,
          systemInstruction: {
            parts: [{ text: getSystemInstruction() }]
          },
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } }
            }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);

        if (msg.setupComplete) {
          setStatus("ready");
          const greeting = siteWide
            ? `Hi! I'm MintBot, your AI assistant. Ask me anything about MintTales!`
            : `Hi! I'm your ${genre} story co-author. Tell me your idea and I'll help shape it!`;
          setMessages([{ role: "ai", text: greeting }]);
          return;
        }

        const parts = msg.serverContent?.modelTurn?.parts ?? [];
        for (const part of parts) {
          if (part.inlineData?.mimeType?.includes("audio")) {
            scheduleAudioPlayback(part.inlineData.data as string);
          }
        }

        // Output transcription — the text version of what the AI is saying
        if (msg.serverContent?.outputTranscription?.text) {
          aiTextBufRef.current += msg.serverContent.outputTranscription.text;
          setCurrentAiText(aiTextBufRef.current);
        }

        if (msg.serverContent?.turnComplete) {
          const finalText = aiTextBufRef.current.trim();
          if (finalText) {
            setMessages(prev => [...prev, { role: "ai", text: finalText }]);
            if (onSuggestion) onSuggestion(finalText);
          }
          aiTextBufRef.current = "";
          setCurrentAiText("");
          setStatus("ready");
        }

        // Input transcription — what the user said via mic
        if (msg.serverContent?.inputTranscription?.text) {
          const userText = msg.serverContent.inputTranscription.text.trim();
          if (userText) setMessages(prev => [...prev, { role: "user", text: userText }]);
        }

      } catch { /* skip parse errors */ }
    };

    ws.onerror = (e) => {
      console.error("Live API WS error:", e);
      setErrorMsg("Connection error — will retry in 5s");
      setStatus("error");
    };

    ws.onclose = (e) => {
      wsRef.current = null;
      if (status === "error" || e.code !== 1000) {
        // Auto-reconnect after 5s if panel is open
        if (isOpen) {
          reconnectTimerRef.current = setTimeout(() => {
            connect();
          }, 5000);
        }
      }
      setStatus("idle");
      setIsMicOn(false);
    };
  }, [apiKey, getSystemInstruction, scheduleAudioPlayback, onSuggestion, siteWide, isOpen, status]);

  const startMic = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: INPUT_SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
      mediaStreamRef.current = stream;

      const micCtx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
      const source = micCtx.createMediaStreamSource(stream);
      const processor = micCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          int16[i] = Math.max(-32768, Math.min(32767, input[i] * 32768));
        }
        const bytes = new Uint8Array(int16.buffer);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        wsRef.current.send(JSON.stringify({
          realtimeInput: {
            mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: btoa(bin) }]
          }
        }));
      };

      source.connect(processor);
      processor.connect(micCtx.destination);
      setIsMicOn(true);
      setStatus("listening");
    } catch (e) {
      console.error("Mic error:", e);
      setErrorMsg("Mic access denied");
    }
  }, []);

  const stopMic = useCallback(() => {
    processorRef.current?.disconnect();
    processorRef.current = null;
    mediaStreamRef.current?.getTracks().forEach(t => t.stop());
    mediaStreamRef.current = null;
    setIsMicOn(false);
    setStatus("thinking");
  }, []);

  const sendText = useCallback(() => {
    const text = textInput.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setMessages(prev => [...prev, { role: "user", text }]);
    wsRef.current.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    }));
    setTextInput("");
    setStatus("thinking");
  }, [textInput]);

  const handleOpen = () => {
    setIsOpen(true);
    setMessages([]);
    connect();
  };

  const handleClose = () => {
    setIsOpen(false);
    disconnect();
  };

  const statusColor = {
    idle: "var(--text-quaternary)",
    connecting: "var(--accent)",
    ready: "#34d399",
    listening: "#ef4444",
    thinking: "var(--accent)",
    speaking: "#a78bfa",
    error: "#ef4444",
  }[status] ?? "#888";

  const statusLabel = {
    idle: "",
    connecting: "Connecting…",
    ready: "Ready",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Speaking…",
    error: errorMsg || "Retrying…",
  }[status] ?? "";

  return (
    <>
      {/* Floating trigger button */}
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleOpen}
            className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full flex items-center justify-center shadow-lg"
            style={{ background: "var(--accent)", boxShadow: "0 0 24px var(--accent-glow)" }}
            title="Talk to AI assistant"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Voice assistant panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="fixed bottom-6 right-6 z-50 w-[340px] rounded-[16px] overflow-hidden shadow-2xl"
            style={{ background: "var(--bg-surface, #18181b)", border: "1px solid var(--border-default, #27272a)" }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-default,#27272a)]">
              <div className="flex items-center gap-2">
                <motion.div
                  className="w-2 h-2 rounded-full"
                  style={{ background: statusColor }}
                  animate={status === "listening" || status === "speaking" ? { scale: [1, 1.4, 1] } : {}}
                  transition={{ repeat: Infinity, duration: 0.8 }}
                />
                <span className="text-[13px] font-semibold text-white">
                  {siteWide ? "MintBot" : "AI Co-Author"}
                </span>
                <span className="text-[10px] text-[var(--text-quaternary,#71717a)] font-mono uppercase tracking-wider">Live API</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px]" style={{ color: statusColor }}>{statusLabel}</span>
                <button onClick={handleClose} className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-quaternary,#71717a)] hover:text-white">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="h-52 overflow-y-auto px-4 py-3 flex flex-col gap-2">
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] px-3 py-2 rounded-[10px] text-[12px] leading-relaxed ${
                      m.role === "user"
                        ? "bg-[var(--accent,#7c3aed)] text-white"
                        : "bg-[var(--bg-elevated,#27272a)] text-[var(--text-secondary,#a1a1aa)]"
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))}

              {currentAiText && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] px-3 py-2 rounded-[10px] text-[12px] leading-relaxed bg-[var(--bg-elevated,#27272a)] text-[var(--text-secondary,#a1a1aa)]">
                    {currentAiText}
                    <motion.span animate={{ opacity: [1, 0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }}>▋</motion.span>
                  </div>
                </div>
              )}

              {status === "connecting" && (
                <div className="flex justify-center py-4">
                  <div className="flex items-center gap-2 text-[11px] text-[var(--text-quaternary,#71717a)]">
                    <div className="spinner" />
                    Connecting to Google Live API…
                  </div>
                </div>
              )}

              {status === "error" && (
                <div className="flex justify-center py-2">
                  <span className="text-[11px] text-red-400">{errorMsg || "Connection failed — retrying…"}</span>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Text input */}
            <div className="px-4 py-2 border-t border-[var(--border-default,#27272a)]">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={textInput}
                  onChange={e => setTextInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && sendText()}
                  placeholder="Type a message…"
                  disabled={status !== "ready" && status !== "speaking"}
                  className="flex-1 bg-[var(--bg-elevated,#27272a)] rounded-[8px] px-3 py-1.5 text-[12px] text-white placeholder-[var(--text-quaternary,#71717a)] outline-none border border-transparent focus:border-[var(--accent,#7c3aed)] disabled:opacity-40"
                />
                <button
                  onClick={sendText}
                  disabled={!textInput.trim() || (status !== "ready" && status !== "speaking")}
                  className="px-3 py-1.5 rounded-[8px] text-[11px] font-medium bg-[var(--accent,#7c3aed)] text-white disabled:opacity-40"
                >
                  Send
                </button>
              </div>
            </div>

            {/* Mic controls */}
            <div className="px-4 py-3 border-t border-[var(--border-default,#27272a)] flex items-center justify-between">
              <p className="text-[10px] text-[var(--text-quaternary,#71717a)]">
                {isMicOn ? "Tap mic to stop" : "Tap mic to speak"}
              </p>
              <motion.button
                whileTap={{ scale: 0.92 }}
                onClick={() => isMicOn ? stopMic() : startMic()}
                disabled={status === "connecting" || status === "error" || status === "idle"}
                className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200 ${
                  isMicOn
                    ? "bg-red-500 shadow-[0_0_20px_rgba(239,68,68,0.5)]"
                    : status === "ready" || status === "speaking" || status === "thinking"
                    ? "cursor-pointer"
                    : "opacity-40 cursor-not-allowed"
                }`}
                style={!isMicOn && (status === "ready" || status === "speaking" || status === "thinking") ? { background: "var(--accent,#7c3aed)", boxShadow: "0 0 16px var(--accent-glow,rgba(124,58,237,0.4))" } : {}}
              >
                {isMicOn ? (
                  <motion.svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"
                    animate={{ scale: [1, 1.15, 1] }} transition={{ repeat: Infinity, duration: 0.6 }}>
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
                  </motion.svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
                  </svg>
                )}
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
