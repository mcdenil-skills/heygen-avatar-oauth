#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const CREDENTIALS_FILE = join(homedir(), ".heygen", "credentials");
const CONFIG_FILE = join(
  homedir(),
  ".config",
  "heygen-avatar-oauth",
  "config.json",
);
const STATE_DIR = join(homedir(), ".local", "state", "heygen-avatar-oauth", "jobs");

export const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
export const MAX_AVATAR_SOURCE_BYTES = 32 * 1024 * 1024;
const MIN_VIDEO_BYTES = 100 * 1024;
const IN_PROGRESS_STATUSES = new Set(["pending", "processing"]);
const AVATAR_SOURCE_EXTENSIONS = Object.freeze({
  photo: new Set([".jpg", ".jpeg", ".png", ".webp"]),
  digital_twin: new Set([".mp4", ".mov", ".webm"]),
});

export const DEFAULT_CONFIG = Object.freeze({
  version: 2,
  defaultGroupId: "",
  defaultGroupName: "",
  defaultLookId: "",
  defaultLookName: "",
  defaultVoiceId: "",
  defaultVoiceName: "",
  aspectLooks: Object.freeze({}),
  defaultAspect: "9:16",
  resolution: "1080p",
});

export function resolveHeyGenBinary(options = {}) {
  const homeDir = options.homeDir ?? homedir();
  const exists = options.exists ?? existsSync;
  const installedBinary = join(homeDir, ".local", "bin", "heygen");
  return exists(installedBinary) ? installedBinary : "heygen";
}

export function cleanHeyGenEnv(source = process.env) {
  const env = { ...source };
  delete env.HEYGEN_API_KEY;
  delete env.HEYGEN_OUTPUT;
  return env;
}

export function parseAuthStatus(payload) {
  const data = payload?.data ?? payload ?? {};
  const subscription = data.subscription ?? {};
  const credits = subscription.credits ?? {};
  return {
    billingType: String(
      data.billing_type ?? data.billingType ?? data.billing ?? "",
    ).toLowerCase(),
    credentialType: String(payload?.credential?.type ?? ""),
    plan: String(subscription.plan ?? data.plan ?? ""),
    premiumCredits:
      credits.premium_credits?.remaining ?? data.premium_credits ?? null,
    addOnCredits:
      credits.add_on_credits?.remaining ?? data.add_on_credits ?? null,
  };
}

export function assertSubscription(status) {
  if (status?.billingType !== "subscription") {
    throw new Error(
      "subscription_required: HeyGen billing is not subscription",
    );
  }
  return status;
}

export function buildDoctorSummary({
  cliVersion,
  credentialMode,
  ffmpeg,
  ffprobe,
  authPayload,
}) {
  const auth = assertSubscription(parseAuthStatus(authPayload));
  const version = String(cliVersion).match(/v\d+\.\d+\.\d+/)?.[0] ?? String(cliVersion);
  return {
    ok: true,
    cliVersion: version,
    credentialMode: String(credentialMode),
    credentialType: auth.credentialType,
    billingType: auth.billingType,
    plan: auth.plan,
    ffmpeg: Boolean(ffmpeg),
    ffprobe: Boolean(ffprobe),
  };
}

function runRaw(binary, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    spawnImpl = spawn,
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(binary, args, {
      cwd,
      env: cleanHeyGenEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const err = new Error(`command_exit_${code}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseJsonOutput(stdout) {
  const text = String(stdout).trim();
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).filter(Boolean).reverse();
    for (const line of lines) {
      try { return JSON.parse(line); } catch {}
    }
    throw new Error("heygen_invalid_json");
  }
}

export async function runHeyGen(args, options = {}) {
  const binary = options.binary ?? resolveHeyGenBinary();
  const { stdout } = await runRaw(binary, args, options);
  return parseJsonOutput(stdout);
}

function requireDataArray(payload, code) {
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error(code);
  }
  return payload.data;
}

export async function listPrivateLooks(options = {}) {
  const run = options.run ?? runHeyGen;
  const groups = requireDataArray(
    await run(["avatar", "list", "--ownership", "private", "--limit", "50"]),
    "avatar_catalog_invalid",
  );
  const result = [];
  for (const group of groups) {
    if (!group?.id || !group?.name) throw new Error("avatar_group_invalid");
    const looks = requireDataArray(
      await run([
        "avatar", "looks", "list",
        "--group-id", String(group.id),
        "--ownership", "private",
        "--limit", "50",
      ]),
      "avatar_looks_invalid",
    );
    for (const look of looks) {
      if (!look?.id || !look?.name) throw new Error("avatar_look_invalid");
      result.push({
        groupId: String(group.id),
        groupName: String(group.name),
        lookId: String(look.id),
        lookName: String(look.name),
        avatarType: String(look.avatar_type ?? ""),
        orientation: String(look.preferred_orientation ?? ""),
        status: String(look.status ?? ""),
        previewImageUrl: String(look.preview_image_url ?? ""),
        width: Number(look.image_width ?? 0),
        height: Number(look.image_height ?? 0),
        defaultVoiceId: String(look.default_voice_id ?? group.default_voice_id ?? ""),
      });
    }
  }
  return result;
}

export function loadConfig(options = {}) {
  const configPath = options.configPath ?? CONFIG_FILE;
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };
  let parsed;
  try { parsed = JSON.parse(readFileSync(configPath, "utf8")); }
  catch { throw new Error("config_invalid_json"); }
  if (![1, 2].includes(parsed?.version)) throw new Error("config_version_invalid");
  if (!["9:16", "16:9"].includes(parsed.defaultAspect)) {
    throw new Error("config_aspect_invalid");
  }
  const aspectLooks = {};
  for (const aspect of ["9:16", "16:9"]) {
    const entry = parsed.aspectLooks?.[aspect];
    if (!entry) continue;
    aspectLooks[aspect] = {
      groupId: String(entry.groupId ?? ""),
      groupName: String(entry.groupName ?? ""),
      lookId: String(entry.lookId ?? ""),
      lookName: String(entry.lookName ?? ""),
    };
  }
  return {
    version: 2,
    defaultGroupId: String(parsed.defaultGroupId ?? ""),
    defaultGroupName: String(parsed.defaultGroupName ?? ""),
    defaultLookId: String(parsed.defaultLookId ?? ""),
    defaultLookName: String(parsed.defaultLookName ?? ""),
    defaultVoiceId: String(parsed.defaultVoiceId ?? ""),
    defaultVoiceName: String(parsed.defaultVoiceName ?? ""),
    aspectLooks,
    defaultAspect: parsed.defaultAspect,
    resolution: "1080p",
  };
}

function writePrivateJson(targetPath, value) {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tempPath = `${targetPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, targetPath);
  chmodSync(targetPath, 0o600);
}

function writeConfig(configPath, config) {
  writePrivateJson(configPath, config);
}

export async function configureDefault(input, options = {}) {
  const aspect = input?.aspect ?? "9:16";
  if (!["9:16", "16:9"].includes(aspect)) throw new Error("aspect_invalid");
  const listLooks = options.listLooks ?? listPrivateLooks;
  const looks = await listLooks(options);
  const selected = looks.find((look) => look.lookId === input?.lookId);
  if (!selected) throw new Error("private_look_not_found");
  if (selected.status && selected.status !== "completed") {
    throw new Error("private_look_not_ready");
  }
  const current = loadConfig(options);
  const config = {
    ...current,
    defaultGroupId: selected.groupId,
    defaultGroupName: selected.groupName,
    defaultLookId: selected.lookId,
    defaultLookName: selected.lookName,
    aspectLooks: {
      ...current.aspectLooks,
      [aspect]: {
        groupId: selected.groupId,
        groupName: selected.groupName,
        lookId: selected.lookId,
        lookName: selected.lookName,
      },
    },
    defaultAspect: aspect,
  };
  writeConfig(options.configPath ?? CONFIG_FILE, config);
  return config;
}

function requireAbsoluteOutput(output) {
  if (!output || !isAbsolute(output)) throw new Error("absolute_output_required");
  return output;
}

function statePathFor(videoId, stateDir = STATE_DIR) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(videoId))) {
    throw new Error("video_id_invalid");
  }
  return join(stateDir, `${videoId}.json`);
}

function saveJobState(videoId, value, options = {}) {
  writePrivateJson(
    statePathFor(videoId, options.stateDir ?? STATE_DIR),
    { version: 1, videoId, ...value },
  );
}

export async function normalizeAudio(inputPath, options = {}) {
  if (!inputPath || !isAbsolute(inputPath)) throw new Error("absolute_audio_required");
  if (!existsSync(inputPath) || !statSync(inputPath).isFile()) {
    throw new Error("audio_file_missing");
  }
  const workDir = options.workDir
    ?? mkdtempSync(join(tmpdir(), "heygen-avatar-audio-"));
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const outputPath = join(workDir, "voice.mp3");
  const runProcess = options.runProcess ?? runRaw;
  const convert = (bitrate) => runProcess("ffmpeg", [
    "-v", "error",
    "-i", inputPath,
    "-vn", "-ar", "44100", "-ac", "1", "-b:a", bitrate,
    "-y", outputPath,
  ]);

  await convert("128k");
  let sizeBytes = statSync(outputPath).size;
  if (sizeBytes > MAX_AUDIO_BYTES) {
    await convert("96k");
    sizeBytes = statSync(outputPath).size;
  }
  if (sizeBytes > MAX_AUDIO_BYTES) throw new Error("audio_too_large");
  return { path: outputPath, sizeBytes };
}

export async function probeVideo(outputPath, options = {}) {
  if (!existsSync(outputPath) || !statSync(outputPath).isFile()) {
    throw new Error("video_file_missing");
  }
  const sizeBytes = statSync(outputPath).size;
  if (sizeBytes < MIN_VIDEO_BYTES) throw new Error("video_file_too_small");
  const runProcess = options.runProcess ?? runRaw;
  const { stdout } = await runProcess("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height",
    "-show_entries", "format=duration,size",
    "-of", "json",
    outputPath,
  ]);
  const payload = parseJsonOutput(stdout);
  const durationSec = Number(payload?.format?.duration ?? 0);
  const videoStream = (payload?.streams ?? []).find(
    (stream) => stream.codec_type === "video",
  );
  if (!(durationSec > 0) || !videoStream) throw new Error("video_probe_invalid");
  return {
    durationSec,
    sizeBytes,
    width: Number(videoStream.width ?? 0),
    height: Number(videoStream.height ?? 0),
    codec: String(videoStream.codec_name ?? ""),
  };
}

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureSubscription(run) {
  return assertSubscription(parseAuthStatus(await run(["auth", "status"])));
}

function summarizeVoice(voice) {
  if (!voice?.voice_id || !voice?.name) throw new Error("voice_invalid");
  return {
    voiceId: String(voice.voice_id),
    voiceName: String(voice.name),
    language: String(voice.language ?? ""),
    gender: String(voice.gender ?? ""),
    type: String(voice.type ?? ""),
    previewAudioUrl: String(voice.preview_audio_url ?? ""),
  };
}

export async function listVoices(input = {}, options = {}) {
  const type = input.type ?? "private";
  if (!["private", "public"].includes(type)) throw new Error("voice_type_invalid");
  const limit = Number(input.limit ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("voice_limit_invalid");
  }
  if (input.gender && !["male", "female"].includes(input.gender)) {
    throw new Error("voice_gender_invalid");
  }
  const run = options.run ?? runHeyGen;
  await ensureSubscription(run);
  const args = ["voice", "list", "--type", type];
  if (input.engine) args.push("--engine", String(input.engine));
  if (input.language) args.push("--language", String(input.language));
  if (input.gender) args.push("--gender", String(input.gender));
  args.push("--limit", String(limit));
  return requireDataArray(await run(args), "voice_catalog_invalid").map(summarizeVoice);
}

export async function designVoices(input, options = {}) {
  const prompt = String(input?.prompt ?? "").trim();
  if (!prompt) throw new Error("voice_prompt_required");
  const seed = Number(input.seed ?? 0);
  if (!Number.isInteger(seed) || seed < 0) throw new Error("voice_seed_invalid");
  if (input.gender && !["male", "female"].includes(input.gender)) {
    throw new Error("voice_gender_invalid");
  }
  const run = options.run ?? runHeyGen;
  await ensureSubscription(run);
  const args = ["voice", "create", "--prompt", prompt, "--seed", String(seed)];
  if (input.gender) args.push("--gender", String(input.gender));
  if (input.locale) args.push("--locale", String(input.locale));
  const payload = await run(args);
  if (!Array.isArray(payload?.data?.voices)) throw new Error("voice_design_invalid");
  return payload.data.voices.map(summarizeVoice);
}

export async function configureVoice(input, options = {}) {
  const voiceId = String(input?.voiceId ?? "").trim();
  if (!voiceId) throw new Error("voice_id_required");
  const run = options.run ?? runHeyGen;
  await ensureSubscription(run);
  const payload = await run(["voice", "get", voiceId]);
  const voice = payload?.data;
  if (!voice?.voice_id || String(voice.voice_id) !== voiceId) {
    throw new Error("voice_not_found");
  }
  if (voice.status === "failed") throw new Error("voice_failed");
  const config = {
    ...loadConfig(options),
    defaultVoiceId: voiceId,
    defaultVoiceName: String(voice.name ?? voiceId),
  };
  writeConfig(options.configPath ?? CONFIG_FILE, config);
  return config;
}

async function downloadUrl(url, targetPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`voice_preview_download_failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(targetPath, bytes, { mode: 0o600 });
}

export async function downloadVoicePreview(input, options = {}) {
  const voiceId = String(input?.voiceId ?? "").trim();
  if (!voiceId) throw new Error("voice_id_required");
  const outputPath = requireAbsoluteOutput(input.output);
  const run = options.run ?? runHeyGen;
  await ensureSubscription(run);
  const voice = (await run(["voice", "get", voiceId]))?.data;
  if (!voice?.voice_id || String(voice.voice_id) !== voiceId) {
    throw new Error("voice_not_found");
  }
  const previewUrl = String(voice.preview_audio_url ?? "");
  if (!previewUrl.startsWith("https://")) throw new Error("voice_preview_unavailable");
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const download = options.download ?? downloadUrl;
  await download(previewUrl, outputPath);
  if (!existsSync(outputPath) || !statSync(outputPath).isFile()) {
    throw new Error("voice_preview_missing");
  }
  chmodSync(outputPath, 0o600);
  const sizeBytes = statSync(outputPath).size;
  if (sizeBytes <= 0) throw new Error("voice_preview_empty");
  return {
    ok: true,
    voiceId,
    voiceName: String(voice.name ?? voiceId),
    outputPath,
    sizeBytes,
  };
}

function orientationForAspect(aspect) {
  return aspect === "16:9" ? "landscape" : "portrait";
}

function summarizeLook(look, groupId, groupName) {
  return {
    ok: true,
    groupId,
    groupName,
    lookId: String(look.id ?? ""),
    lookName: String(look.name ?? ""),
    avatarType: String(look.avatar_type ?? ""),
    orientation: String(look.preferred_orientation ?? ""),
    status: String(look.status ?? ""),
    previewImageUrl: String(look.preview_image_url ?? ""),
  };
}

async function waitForAvatarReady(input, options = {}) {
  const run = options.run ?? runHeyGen;
  const sleep = options.sleep ?? sleepDefault;
  const maxAttempts = options.maxAttempts ?? 30;
  const intervalMs = options.intervalMs ?? 10_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const looks = requireDataArray(
      await run([
        "avatar", "looks", "list",
        "--group-id", input.groupId,
        "--ownership", "private",
        "--limit", "50",
      ]),
      "avatar_looks_invalid",
    );
    const look = looks.find((item) => String(item?.id ?? "") === input.lookId);
    if (look?.status === "failed") throw new Error("avatar_creation_failed");
    if (look?.status === "pending_consent") {
      return {
        ...summarizeLook(look, input.groupId, input.groupName),
        requiresConsent: true,
      };
    }
    const ready = look?.status === "completed"
      && Boolean(look.preview_image_url)
      && Number(look.image_width) > 0
      && Number(look.image_height) > 0;
    if (ready) return summarizeLook(look, input.groupId, input.groupName);
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  throw new Error("avatar_not_ready_timeout");
}

export async function createAvatar(input, options = {}) {
  if (!input?.approveCreditSpend) throw new Error("credit_spend_not_approved");
  const type = String(input.type ?? "");
  if (!["prompt", "photo", "digital_twin"].includes(type)) {
    throw new Error("avatar_type_invalid");
  }
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("avatar_name_required");
  const aspect = input.aspect ? String(input.aspect) : "";
  if (aspect && !["auto", "16:9", "9:16", "1:1", "4:5", "5:4"].includes(aspect)) {
    throw new Error("avatar_aspect_invalid");
  }
  if (type === "prompt" && !String(input.prompt ?? "").trim()) {
    throw new Error("avatar_prompt_required");
  }
  if (type !== "prompt") {
    if (!input.file || !isAbsolute(input.file)) throw new Error("absolute_avatar_file_required");
    if (!existsSync(input.file) || !statSync(input.file).isFile()) {
      throw new Error("avatar_file_missing");
    }
    const sourceStat = statSync(input.file);
    const allowedExtensions = AVATAR_SOURCE_EXTENSIONS[type];
    if (!allowedExtensions?.has(extname(input.file).toLowerCase())) {
      throw new Error("avatar_file_type_invalid");
    }
    if (sourceStat.size > MAX_AVATAR_SOURCE_BYTES) {
      throw new Error("avatar_file_too_large");
    }
  }

  const run = options.run ?? runHeyGen;
  await ensureSubscription(run);
  const workDir = mkdtempSync(join(tmpdir(), "heygen-avatar-create-"));
  try {
    const request = { type, name };
    if (type === "prompt") {
      request.prompt = String(input.prompt).trim();
      if (aspect) request.aspect_ratio = aspect;
    } else {
      const uploaded = await run(["asset", "create", "--file", input.file]);
      const assetId = String(uploaded?.data?.asset_id ?? "");
      if (!assetId) throw new Error("asset_id_missing");
      request.file = { type: "asset_id", asset_id: assetId };
    }
    if (input.groupId) request.avatar_group_id = String(input.groupId);

    const requestPath = join(workDir, "request.json");
    writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
    const created = await run(["avatar", "create", "-d", requestPath]);
    const lookId = String(created?.data?.avatar_item?.id ?? "");
    const groupId = String(
      created?.data?.avatar_item?.group_id
      ?? created?.data?.avatar_group?.id
      ?? input.groupId
      ?? "",
    );
    if (!groupId) throw new Error("avatar_group_id_missing");
    const groupName = String(created?.data?.avatar_group?.name ?? name);
    const immediateStatus = String(
      created?.data?.avatar_item?.status
      ?? created?.data?.avatar_group?.status
      ?? "",
    );
    if (immediateStatus === "pending_consent") {
      return {
        ...summarizeLook({
          ...created.data.avatar_item,
          name: created.data.avatar_item?.name ?? name,
          status: "pending_consent",
        }, groupId, groupName),
        requiresConsent: true,
      };
    }
    if (!lookId) throw new Error("avatar_look_id_missing");
    return waitForAvatarReady({ groupId, groupName, lookId }, {
      ...options,
      run,
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export async function createAvatarConsent(input, options = {}) {
  if (!input?.approve) throw new Error("avatar_consent_not_approved");
  const groupId = String(input.groupId ?? "").trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(groupId)) throw new Error("avatar_group_id_invalid");
  const run = options.run ?? runHeyGen;
  await ensureSubscription(run);
  const payload = await run(["avatar", "consent", "create", groupId]);
  const group = payload?.data?.avatar_group;
  const consentUrl = String(payload?.data?.url ?? "");
  if (!group?.id || String(group.id) !== groupId) {
    throw new Error("avatar_consent_group_invalid");
  }
  if (!consentUrl.startsWith("https://")) {
    throw new Error("avatar_consent_url_missing");
  }
  return {
    ok: true,
    groupId,
    groupName: String(group.name ?? ""),
    status: String(group.status ?? "pending_consent"),
    consentUrl,
  };
}

async function resolveRenderLook(input, config, options = {}) {
  if (input.lookId) return {
    lookId: String(input.lookId),
    lookName: "",
    groupId: "",
  };

  const aspectDefault = config.aspectLooks?.[input.aspect] ?? {};
  const groupId = String(aspectDefault.groupId ?? config.defaultGroupId ?? "");
  if (!groupId) {
    const legacyLookId = String(aspectDefault.lookId ?? config.defaultLookId ?? "");
    if (!legacyLookId) throw new Error("private_look_not_configured");
    return {
      lookId: legacyLookId,
      lookName: String(aspectDefault.lookName ?? config.defaultLookName ?? ""),
      groupId: "",
    };
  }

  const listLooks = options.listLooks ?? listPrivateLooks;
  const expectedOrientation = orientationForAspect(input.aspect);
  const readyForAspect = (await listLooks(options)).filter((look) => (
    look.status === "completed" && look.orientation === expectedOrientation
  ));
  const candidates = readyForAspect.filter((look) => look.groupId === groupId);
  const preferredLookId = String(aspectDefault.lookId ?? "");
  const preferredLookName = String(
    aspectDefault.lookName ?? config.defaultLookName ?? "",
  );
  const preferred = candidates.find((look) => look.lookId === preferredLookId)
    ?? candidates.find((look) => look.lookName === preferredLookName)
    ?? candidates[0]
    ?? (readyForAspect.length === 1 ? readyForAspect[0] : null);
  if (!preferred) throw new Error(`matching_look_not_found: ${expectedOrientation}`);
  return preferred;
}

async function completeExistingVideo(input, options = {}) {
  const run = options.run ?? runHeyGen;
  const probe = options.probe ?? probeVideo;
  const sleep = options.sleep ?? sleepDefault;
  const maxAttempts = options.maxAttempts ?? 120;
  const intervalMs = options.intervalMs ?? 15_000;
  const outputPath = requireAbsoluteOutput(input.output);
  const videoId = String(input.videoId ?? "");
  statePathFor(videoId, options.stateDir ?? STATE_DIR);

  if (existsSync(outputPath)) {
    const verified = await probe(outputPath, options);
    return {
      ok: true,
      videoId,
      outputPath,
      durationSec: verified.durationSec,
      sizeBytes: verified.sizeBytes,
      width: verified.width,
      height: verified.height,
    };
  }

  let unreadable = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let payload;
    try {
      payload = await run(["video", "get", videoId]);
    } catch {
      unreadable += 1;
      if (unreadable >= 4) {
        saveJobState(videoId, {
          status: "unreadable",
          outputPath,
          updatedAt: new Date().toISOString(),
        }, options);
        throw new Error("auth_or_network_unreadable");
      }
      await sleep(intervalMs);
      continue;
    }

    const status = String(payload?.data?.status ?? "").toLowerCase();
    if (!status) {
      unreadable += 1;
      if (unreadable >= 4) throw new Error("auth_or_network_unreadable");
      await sleep(intervalMs);
      continue;
    }
    unreadable = 0;

    if (IN_PROGRESS_STATUSES.has(status)) {
      if (attempt < maxAttempts) await sleep(intervalMs);
      continue;
    }
    if (status === "failed") {
      saveJobState(videoId, {
        status: "failed",
        failureCode: String(payload?.data?.failure_code ?? ""),
        failureMessage: String(payload?.data?.failure_message ?? ""),
        outputPath,
        updatedAt: new Date().toISOString(),
      }, options);
      throw new Error(`video_failed: ${payload?.data?.failure_code ?? "unknown"}`);
    }
    if (status !== "completed") {
      saveJobState(videoId, {
        status: "unknown",
        observedStatus: status,
        outputPath,
        updatedAt: new Date().toISOString(),
      }, options);
      throw new Error(`video_status_unknown: ${status}`);
    }

    const outputDir = dirname(outputPath);
    const outputDirAlreadyExists = existsSync(outputDir);
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    if (!outputDirAlreadyExists) chmodSync(outputDir, 0o700);
    await run(["video", "download", videoId, "--output-path", outputPath]);
    chmodSync(outputPath, 0o600);
    const verified = await probe(outputPath, options);
    const result = {
      ok: true,
      videoId,
      outputPath,
      durationSec: verified.durationSec,
      sizeBytes: verified.sizeBytes,
      width: verified.width,
      height: verified.height,
    };
    saveJobState(videoId, {
      status: "completed",
      outputPath,
      durationSec: result.durationSec,
      sizeBytes: result.sizeBytes,
      width: result.width,
      height: result.height,
      updatedAt: new Date().toISOString(),
    }, options);
    return result;
  }

  saveJobState(videoId, {
    status: "timeout",
    outputPath,
    updatedAt: new Date().toISOString(),
  }, options);
  throw new Error("video_timeout");
}

export async function resumeVideo(input, options = {}) {
  const run = options.run ?? runHeyGen;
  await ensureSubscription(run);
  return completeExistingVideo(input, { ...options, run });
}

export async function renderAvatarVideo(input, options = {}) {
  if (!input?.approveCreditSpend) throw new Error("credit_spend_not_approved");
  const run = options.run ?? runHeyGen;
  await ensureSubscription(run);

  const config = options.config ?? loadConfig(options);
  const aspect = input.aspect ?? config.defaultAspect ?? "9:16";
  if (!["9:16", "16:9"].includes(aspect)) throw new Error("aspect_invalid");
  const selectedLook = await resolveRenderLook(
    { ...input, aspect },
    config,
    options,
  );
  const lookId = selectedLook.lookId;
  const outputPath = requireAbsoluteOutput(input.output);
  const workDir = mkdtempSync(join(tmpdir(), "heygen-avatar-render-"));
  const normalize = options.normalize ?? normalizeAudio;

  try {
    const normalized = await normalize(input.audio, { ...options, workDir });
    if (Number(normalized?.sizeBytes) > MAX_AUDIO_BYTES) {
      throw new Error("audio_too_large");
    }
    const asset = await run(["asset", "create", "--file", normalized.path]);
    const assetId = String(asset?.data?.asset_id ?? "");
    if (!assetId) throw new Error("asset_id_missing");

    const requestPath = join(workDir, "request.json");
    writeFileSync(requestPath, `${JSON.stringify({
      type: "avatar",
      avatar_id: lookId,
      audio_asset_id: assetId,
      resolution: "1080p",
      aspect_ratio: aspect,
    })}\n`, { mode: 0o600 });

    const created = await run(["video", "create", "-d", requestPath]);
    const videoId = String(created?.data?.video_id ?? "");
    if (!videoId) throw new Error("video_id_missing");
    saveJobState(videoId, {
      status: String(created?.data?.status ?? "created"),
      outputPath,
      lookId,
      lookName: selectedLook.lookName,
      groupId: selectedLook.groupId,
      aspect,
      createdAt: new Date().toISOString(),
    }, options);
    return await completeExistingVideo({ videoId, output: outputPath }, {
      ...options,
      run,
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function commandWorks(binary, args) {
  try {
    await runRaw(binary, args);
    return true;
  } catch {
    return false;
  }
}

export async function doctor(options = {}) {
  const binary = options.binary ?? resolveHeyGenBinary();
  if (!existsSync(CREDENTIALS_FILE)) throw new Error("heygen_oauth_missing");

  let checks;
  try {
    checks = await Promise.all([
      runRaw(binary, ["--version"], options),
      runHeyGen(["auth", "status"], { ...options, binary }),
      commandWorks("ffmpeg", ["-version"]),
      commandWorks("ffprobe", ["-version"]),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("heygen_cli_missing");
    throw error;
  }
  const [{ stdout: cliVersion }, authPayload, ffmpeg, ffprobe] = checks;
  const credentialMode = (statSync(CREDENTIALS_FILE).mode & 0o777)
    .toString(8)
    .padStart(3, "0");
  return buildDoctorSummary({
    cliVersion,
    credentialMode,
    ffmpeg,
    ffprobe,
    authPayload,
  });
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected_argument: ${token}`);
    const key = token.slice(2);
    if (["approve-credit-spend", "approve-consent", "set-default"].includes(key)) {
      flags[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing_value: ${token}`);
    flags[key] = value;
    index += 1;
  }
  return flags;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "doctor") {
    printJson(await doctor());
    return;
  }
  if (command === "avatars") {
    printJson({ ok: true, looks: await listPrivateLooks() });
    return;
  }
  if (command === "configure") {
    const flags = parseFlags(rest);
    printJson({
      ok: true,
      config: await configureDefault({
        lookId: flags["look-id"],
        aspect: flags.aspect,
      }),
    });
    return;
  }
  if (command === "avatar-create") {
    const flags = parseFlags(rest);
    const created = await createAvatar({
      type: flags.type,
      name: flags.name,
      prompt: flags.prompt,
      file: flags.file,
      groupId: flags["group-id"],
      aspect: flags.aspect,
      approveCreditSpend: flags["approve-credit-spend"] === true,
    });
    let config;
    if (flags["set-default"] === true && created.status === "completed") {
      config = await configureDefault({
        lookId: created.lookId,
        aspect: flags.aspect === "16:9" ? "16:9" : "9:16",
      });
    }
    printJson({ ...created, ...(config ? { config } : {}) });
    return;
  }
  if (command === "avatar-consent") {
    const flags = parseFlags(rest);
    printJson(await createAvatarConsent({
      groupId: flags["group-id"],
      approve: flags["approve-consent"] === true,
    }));
    return;
  }
  if (command === "voices") {
    const flags = parseFlags(rest);
    printJson({
      ok: true,
      voices: await listVoices({
        type: flags.type,
        engine: flags.engine,
        language: flags.language,
        gender: flags.gender,
        limit: flags.limit,
      }),
    });
    return;
  }
  if (command === "voice-design") {
    const flags = parseFlags(rest);
    printJson({
      ok: true,
      voices: await designVoices({
        prompt: flags.prompt,
        locale: flags.locale,
        gender: flags.gender,
        seed: flags.seed,
      }),
    });
    return;
  }
  if (command === "configure-voice") {
    const flags = parseFlags(rest);
    printJson({
      ok: true,
      config: await configureVoice({ voiceId: flags["voice-id"] }),
    });
    return;
  }
  if (command === "voice-preview") {
    const flags = parseFlags(rest);
    printJson(await downloadVoicePreview({
      voiceId: flags["voice-id"],
      output: flags.output,
    }));
    return;
  }
  if (command === "render") {
    const flags = parseFlags(rest);
    printJson(await renderAvatarVideo({
      audio: flags.audio,
      lookId: flags["look-id"],
      aspect: flags.aspect,
      output: flags.output,
      approveCreditSpend: flags["approve-credit-spend"] === true,
    }));
    return;
  }
  if (command === "resume") {
    const flags = parseFlags(rest);
    printJson(await resumeVideo({
      videoId: flags["video-id"],
      output: flags.output,
    }));
    return;
  }
  if (command === "help" || command === "--help" || !command) {
    printJson({
      commands: [
        "doctor",
        "avatars",
        "configure",
        "avatar-create",
        "avatar-consent",
        "voices",
        "voice-design",
        "configure-voice",
        "voice-preview",
        "render",
        "resume",
      ],
    });
    return;
  }
  throw new Error(`unknown_command: ${command}`);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    printJson({ ok: false, error: error.message });
    process.exitCode = 1;
  });
}
