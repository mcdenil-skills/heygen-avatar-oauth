#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const DEFAULT_MODEL = "eleven_multilingual_v2";
const DEFAULT_FORMAT = "mp3_44100_128";
const DEFAULT_SETTINGS = Object.freeze({
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
  speed: 1,
});
const DEFAULT_STATE_DIR = join(
  homedir(),
  ".local",
  "state",
  "heygen-avatar-oauth",
  "elevenlabs",
);
const MAX_TEXT_CHARS = 10_000;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MIN_AUDIO_BYTES = 512;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateVoiceId(value) {
  const voiceId = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(voiceId)) {
    throw new Error("elevenlabs_voice_not_configured");
  }
  return voiceId;
}

function validateApiKey(value) {
  const apiKey = String(value ?? "").trim();
  if (!apiKey || apiKey.length > 512 || /[\x00-\x20\x7f]/.test(apiKey)) {
    throw new Error("elevenlabs_key_not_configured");
  }
  return apiKey;
}

function validateTextFile(textFile) {
  if (!textFile || !isAbsolute(textFile)) {
    throw new Error("absolute_text_file_required");
  }
  if (!existsSync(textFile) || !statSync(textFile).isFile()) {
    throw new Error("text_file_missing");
  }
  const text = readFileSync(textFile, "utf8").trim();
  const length = Array.from(text).length;
  if (!length) throw new Error("text_empty");
  if (length > MAX_TEXT_CHARS) throw new Error("text_too_long");
  return text;
}

function validateOutput(output) {
  if (!output || !isAbsolute(output)) throw new Error("absolute_audio_output_required");
  return output;
}

function normalizeSettings(value = {}) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("elevenlabs_settings_invalid");
  }
  const settings = { ...DEFAULT_SETTINGS, ...value };
  for (const [key, setting] of Object.entries(settings)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) {
      throw new Error("elevenlabs_settings_invalid");
    }
    if (key === "use_speaker_boost") {
      if (typeof setting !== "boolean") throw new Error("elevenlabs_settings_invalid");
      continue;
    }
    if (!Number.isFinite(setting)) throw new Error("elevenlabs_settings_invalid");
    const valid = key === "speed"
      ? setting >= 0.7 && setting <= 1.2
      : setting >= 0 && setting <= 1;
    if (!valid) throw new Error("elevenlabs_settings_invalid");
  }
  return Object.fromEntries(
    Object.entries(settings).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function loadElevenLabsConfig(env = process.env) {
  const apiKey = String(env.ELEVENLABS_API_KEY ?? "").trim()
    || String(env.ELEVENLABS_API ?? "").trim();
  return {
    apiKey,
    voiceId: String(env.ELEVENLABS_VOICE_ID ?? "").trim(),
  };
}

export function buildSpeechCacheKey(input) {
  const payload = {
    text: String(input.text ?? ""),
    voiceId: validateVoiceId(input.voiceId),
    modelId: String(input.modelId ?? DEFAULT_MODEL),
    outputFormat: String(input.outputFormat ?? DEFAULT_FORMAT),
    voiceSettings: normalizeSettings(input.voiceSettings),
  };
  return sha256(JSON.stringify(payload));
}

function statePaths(cacheKey, stateDir) {
  const dir = join(stateDir, cacheKey);
  return {
    dir,
    attempt: join(dir, "attempt.json"),
    audio: join(dir, "speech.mp3"),
    receipt: join(dir, "receipt.json"),
  };
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivateAtomic(path, value) {
  ensurePrivateDir(dirname(path));
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, value, { mode: 0o600, flag: "wx" });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

function readVerifiedCache(paths, cacheKey) {
  if (!existsSync(paths.receipt)) return null;
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(paths.receipt, "utf8"));
  } catch {
    throw new Error("elevenlabs_cache_invalid");
  }
  if (!existsSync(paths.audio) || !statSync(paths.audio).isFile()) {
    throw new Error("elevenlabs_cache_invalid");
  }
  const audio = readFileSync(paths.audio);
  if (
    receipt?.version !== 1
    || receipt.cacheKey !== cacheKey
    || receipt.audioSha256 !== sha256(audio)
    || audio.length < MIN_AUDIO_BYTES
    || audio.length > MAX_AUDIO_BYTES
  ) {
    throw new Error("elevenlabs_cache_invalid");
  }
  return { audio, receipt };
}

function publishAudio(cacheAudioPath, outputPath, expectedSha) {
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  if (existsSync(outputPath)) {
    if (!statSync(outputPath).isFile()) throw new Error("audio_output_invalid");
    const existing = readFileSync(outputPath);
    if (sha256(existing) !== expectedSha) throw new Error("audio_output_exists");
    return;
  }
  copyFileSync(cacheAudioPath, outputPath, fsConstants.COPYFILE_EXCL);
  chmodSync(outputPath, 0o600);
}

async function readBoundedAudio(response) {
  const declared = Number(response.headers?.get?.("content-length") ?? 0);
  if (declared > MAX_AUDIO_BYTES) throw new Error("elevenlabs_audio_too_large");
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < MIN_AUDIO_BYTES || audio.length > MAX_AUDIO_BYTES) {
    throw new Error("elevenlabs_audio_invalid");
  }
  return audio;
}

export async function synthesizeSpeech(input, options = {}) {
  const text = input.text ?? validateTextFile(input.textFile);
  const textLength = Array.from(String(text)).length;
  if (!String(text).trim()) throw new Error("text_empty");
  if (textLength > MAX_TEXT_CHARS) throw new Error("text_too_long");
  const outputPath = validateOutput(input.output);
  const envConfig = loadElevenLabsConfig(options.env ?? process.env);
  const voiceId = validateVoiceId(input.voiceId ?? envConfig.voiceId);
  const modelId = String(input.modelId ?? DEFAULT_MODEL);
  const outputFormat = String(input.outputFormat ?? DEFAULT_FORMAT);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(modelId)) {
    throw new Error("elevenlabs_model_invalid");
  }
  if (outputFormat !== DEFAULT_FORMAT) throw new Error("elevenlabs_format_invalid");
  const voiceSettings = normalizeSettings(input.voiceSettings);
  const cacheKey = buildSpeechCacheKey({
    text,
    voiceId,
    modelId,
    outputFormat,
    voiceSettings,
  });
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const paths = statePaths(cacheKey, stateDir);
  ensurePrivateDir(paths.dir);

  const cached = readVerifiedCache(paths, cacheKey);
  if (cached) {
    publishAudio(paths.audio, outputPath, cached.receipt.audioSha256);
    return {
      ok: true,
      outputPath,
      sizeBytes: cached.audio.length,
      characters: textLength,
      cached: true,
    };
  }
  if (existsSync(paths.attempt)) {
    throw new Error("elevenlabs_previous_attempt_unresolved");
  }
  if (existsSync(outputPath)) throw new Error("audio_output_exists");
  if (!input.approveCost) throw new Error("elevenlabs_spend_not_approved");
  const apiKey = validateApiKey(input.apiKey ?? envConfig.apiKey);

  const marker = openSync(paths.attempt, "wx", 0o600);
  try {
    writeFileSync(marker, `${JSON.stringify({ version: 1, cacheKey })}\n`);
  } finally {
    closeSync(marker);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs ?? 60_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("elevenlabs_timeout_invalid");
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = null;
  try {
    const response = await fetchImpl(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${outputFormat}`,
      {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: voiceSettings,
        }),
      },
    );
    status = Number(response.status);
    if (!response.ok) throw new Error("provider_failure");
    const audio = await readBoundedAudio(response);
    const audioSha256 = sha256(audio);
    writePrivateAtomic(paths.audio, audio);
    writePrivateAtomic(paths.receipt, `${JSON.stringify({
      version: 1,
      cacheKey,
      audioSha256,
      sizeBytes: audio.length,
      characters: textLength,
      characterCost: String(response.headers?.get?.("character-cost") ?? ""),
      requestId: String(response.headers?.get?.("request-id") ?? ""),
      createdAt: new Date().toISOString(),
    })}\n`);
    publishAudio(paths.audio, outputPath, audioSha256);
    return {
      ok: true,
      outputPath,
      sizeBytes: audio.length,
      characters: textLength,
      cached: false,
    };
  } catch {
    const suffix = status && status >= 400 ? `_http_${status}` : "";
    throw new Error(`elevenlabs_generation_uncertain${suffix}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
