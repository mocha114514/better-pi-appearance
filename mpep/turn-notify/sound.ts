import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCacheDir } from "../shared/paths.ts";

const SAMPLE_RATE = 22050;
const DURATION_S = 1.5;
const BUBBLE_COUNT = 16;
const SEED = 0xb0bb1e;

/** Deterministic PRNG (LCG) so the synthesized waveform is stable across runs and tests. */
function createRandom(): () => number {
	let state = SEED >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
};

/**
 * Synthesizes a ~1.5s "bubble stream": rapid bubble bloops that accelerate and
 * crescendo from quiet to loud. Each bubble is a sine chirp whose frequency rises
 * quickly (the acoustic signature of a real bubble) under a fast-attack,
 * exponentially-decaying envelope.
 */
export function synthesizeBubbleSamples(): Int16Array {
	const random = createRandom();
	const mix = new Float64Array(Math.round(SAMPLE_RATE * DURATION_S));
	for (let i = 0; i < BUBBLE_COUNT; i++) {
		const progress = i / (BUBBLE_COUNT - 1);
		// Accelerating schedule: gaps shrink toward the end of the stream.
		const startS = (DURATION_S - 0.12) * Math.pow(progress, 1.4);
		const durationS = 0.045 + random() * 0.05;
		const amplitude = 0.1 + 0.9 * Math.pow(progress, 1.6); // pronounced crescendo from quiet to loud
		const startFreq = 350 + random() * 300;
		const endFreq = startFreq * (1.6 + random() * 0.9);
		renderBubble(mix, Math.round(startS * SAMPLE_RATE), Math.round(durationS * SAMPLE_RATE), startFreq, endFreq, amplitude);
	}
	return normalize(mix);
}

/** Renders one bubble: exponential frequency chirp, fast attack, exponential decay. */
function renderBubble(mix: Float64Array, start: number, length: number, startFreq: number, endFreq: number, amplitude: number): void {
	const attackSamples = Math.max(1, Math.round(0.004 * SAMPLE_RATE));
	const decayTau = length / 3;
	let phase = 0;
	for (let n = 0; n < length && start + n < mix.length; n++) {
		const freq = startFreq * Math.pow(endFreq / startFreq, n / length);
		phase += (2 * Math.PI * freq) / SAMPLE_RATE;
		const attack = Math.min(1, n / attackSamples);
		mix[start + n] += Math.sin(phase) * attack * Math.exp(-n / decayTau) * amplitude;
	}
}

/** Scales the mix to 80% of full scale so overlapping bubbles never clip. */
function normalize(mix: Float64Array): Int16Array {
	let peak = 0;
	for (const sample of mix) peak = Math.max(peak, Math.abs(sample));
	const scale = peak > 0 ? (0.8 * 32767) / peak : 0;
	const out = new Int16Array(mix.length);
	for (let i = 0; i < mix.length; i++) out[i] = Math.round(mix[i] * scale);
	return out;
}

/** Encodes 16-bit mono PCM samples as a RIFF/WAVE buffer. */
export function encodeWav(samples: Int16Array): Buffer {
	const dataSize = samples.length * 2;
	const buffer = Buffer.alloc(44 + dataSize);
	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVEfmt ", 8, "ascii");
	buffer.writeUInt32LE(16, 16); // PCM header size
	buffer.writeUInt16LE(1, 20); // PCM format
	buffer.writeUInt16LE(1, 22); // mono
	buffer.writeUInt32LE(SAMPLE_RATE, 24);
	buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
	buffer.writeUInt16LE(2, 32); // block align
	buffer.writeUInt16LE(16, 34); // bits per sample
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(dataSize, 40);
	for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(samples[i], 44 + i * 2);
	return buffer;
}

const SOUND_DIR = "turn-notify";
// Bump this version whenever the synthesis parameters change: the cached file is
// keyed by name, and an unchanged duration would otherwise keep the stale WAV.
const SOUND_VERSION = 1;
const SOUND_FILE = `bubble-v${SOUND_VERSION}.wav`;
const EXPECTED_SIZE = 44 + Math.round(SAMPLE_RATE * DURATION_S) * 2;

/**
 * Writes the synthesized chime into the cache directory once and reuses it
 * afterwards. Returns undefined on any I/O failure, so callers can fall back
 * to the platform's built-in notification sound.
 */
export function ensureBubbleSound(cacheDir: string = getCacheDir()): string | undefined {
	try {
		const path = join(cacheDir, SOUND_DIR, SOUND_FILE);
		if (!existsSync(path) || statSync(path).size !== EXPECTED_SIZE) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, encodeWav(synthesizeBubbleSamples()));
		}
		return path;
	} catch {
		return undefined;
	}
}
