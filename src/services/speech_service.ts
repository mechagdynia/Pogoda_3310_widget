/**
 * NOKIA 3310 WEATHER RETRO — speech service.
 *
 * Thin, dependency-free wrapper around the Web Speech API
 * (SpeechRecognition / webkitSpeechRecognition) tuned for Polish
 * place-name capture ("pogoda w Krakowie", "Krakow", ...).
 *
 * The service degrades gracefully: if the browser lacks support it simply
 * reports `supported = false` and the UI hides the voice entry point.
 */

/* ------------------------------------------------------------------ *
 *  Minimal ambient typings (avoids depending on @types packages)
 * ------------------------------------------------------------------ */

interface SRAlternative {
  transcript: string;
  confidence: number;
}

interface SREventBase {
  resultIndex: number;
}

interface SREvent extends SREventBase {
  results: {
    length: number;
    [index: number]: {
      length: number;
      [index: number]: SRAlternative;
      isFinal: boolean;
    };
  };
  resultIsFinal: boolean;
}

interface SRErrorEvent {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/* ------------------------------------------------------------------ *
 *  Public API
 * ------------------------------------------------------------------ */

export type VoiceState = 'idle' | 'listening' | 'processing';

export interface VoiceCallbacks {
  /** Fired when the recognition state changes. */
  onState: (state: VoiceState) => void;
  /** Fired with the final (best-effort) transcript. */
  onTranscript: (text: string) => void;
  /** Fired when a stop could not start / recognition failed. */
  onError: (message: string) => void;
}

export class SpeechService {
  private rec: SpeechRecognitionLike | null = null;
  private active = false;
  readonly supported: boolean;

  constructor() {
    this.supported = getRecognitionCtor() !== null;
  }

  get listening(): boolean {
    return this.active;
  }

  /**
   * Start listening (pl-PL). Resolves via callbacks, never via promise,
   * to keep the call site simple and cancellation trivial.
   */
  listen(cb: VoiceCallbacks): void {
    if (!this.supported) {
      cb.onError('BRAK WSPIERCZANIA MOWY');
      return;
    }
    if (this.active) {
      this.stop();
    }

    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      cb.onError('BRAK WSPIERCZANIA MOWY');
      return;
    }

    const rec = new Ctor();
    this.rec = rec;
    rec.lang = 'pl-PL';
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      this.active = true;
      cb.onState('listening');
    };

    rec.onresult = (e: SREvent) => {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.length > 0 && r[0]) {
          text = (text ? `${text} ` : '') + r[0].transcript;
        }
      }
      text = text.trim();
      cb.onState('processing');
      cb.onTranscript(text);
    };

    rec.onerror = (e: SRErrorEvent) => {
      this.active = false;
      // 'no-speech' / 'aborted' are routine — surface a short message only
      // for real failures.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        cb.onError('ODMOWIONO DOSTĘPU DO MIKROFONU');
      } else if (e.error === 'audio-capture') {
        cb.onError('BRAK MIKROFONU');
      } else {
        cb.onError('BŁĄD ROZPOZNAWANIA');
      }
    };

    rec.onend = () => {
      if (this.active) {
        // recognition ended without producing a final result
        this.active = false;
        cb.onState('idle');
      }
    };

    try {
      rec.start();
    } catch {
      this.rec = null;
      cb.onError('BŁĄD ROZPOZNAWANIA');
    }
  }

  /** Stop an ongoing capture (idempotent). */
  stop(): void {
    if (this.rec) {
      try {
        this.rec.stop();
      } catch {
        /* already stopped */
      }
      this.rec = null;
    }
    this.active = false;
  }

  /** Tear down (page hide / app quit). */
  dispose(): void {
    this.stop();
  }
}

/* ------------------------------------------------------------------ *
 *  Transcript -> place name
 * ------------------------------------------------------------------ */

const PLACE_PREFIXES: RegExp =
  /^\s*(pogoda|prognoza|jak\s+jest|ile\s+stopni|temperatura)\s*(w|we|w\s+okolicach\s+|dla\s+|w\s+dziennie\s+)?/i;

const FILLER_WORDS: RegExp =
  /\b(pogoda|prognoza|dla|w|we|miasta|miasto|pokaż|pokaż|pokaz|proszę|proszę|zrób|zrob)\b/gi;

/**
 * Strip the typical Polish lead-ins from a transcript so the remainder
 * can be used directly as a geocoding query.
 *   "pogoda w krakowie"  -> "krakowie"
 *   "ile jest stopni w górach" -> "górach"
 */
export function extractPlace(transcript: string): string {
  let t = transcript.trim();
  if (!t) return '';
  t = t.replace(PLACE_PREFIXES, '');
  t = t.replace(FILLER_WORDS, ' ');
  t = t.replace(/[.!?]+$/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  // Drop a leading preposition left dangling ("w krakowie" -> "krakowie")
  t = t.replace(/^(w|we|na|z)\s+/i, '');
  return t.trim();
}

/** Shared singleton. */
export const speechService = new SpeechService();
