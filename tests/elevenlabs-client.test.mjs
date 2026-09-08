import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSpeechCacheKey,
  loadElevenLabsConfig,
  synthesizeSpeech,
} from "../scripts/elevenlabs-client.mjs";
import { renderTextAvatarVideo } from "../scripts/heygen-client.mjs";

const TEST_KEY = "synthetic-elevenlabs-key";
const TEST_VOICE = "synthetic-elevenlabs-voice";
const TEST_TEXT = "Это короткая проверка голоса.";
const TEST_AUDIO = Buffer.alloc(2048, 7);

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "heygen-text-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const textFile = join(root, "script.txt");
  writeFileSync(textFile, TEST_TEXT);
  return { root, textFile };
}

function response(status = 200, audio = TEST_AUDIO) {
  const headers = new Map([
    ["content-length", String(audio.length)],
    ["character-cost", "31"],
    ["request-id", "synthetic-request"],
  ]);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    arrayBuffer: async () => audio,
  };
}

test("ElevenLabs settings come from environment and stay out of cache metadata", () => {
  assert.deepEqual(loadElevenLabsConfig({
    ELEVENLABS_API: TEST_KEY,
    ELEVENLABS_VOICE_ID: TEST_VOICE,
  }), {
    apiKey: TEST_KEY,
    voiceId: TEST_VOICE,
  });
  const key = buildSpeechCacheKey({ text: TEST_TEXT, voiceId: TEST_VOICE });
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key.includes(TEST_KEY), false);
  assert.equal(key.includes(TEST_VOICE), false);
  assert.equal(key.includes(TEST_TEXT), false);
});

test("speech synthesis requires approval and reuses a verified cache", async (t) => {
  const { root, textFile } = workspace(t);
  const stateDir = join(root, "state");
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response();
  };
  const env = {
    ELEVENLABS_API: TEST_KEY,
    ELEVENLABS_VOICE_ID: TEST_VOICE,
  };

  await assert.rejects(synthesizeSpeech({
    textFile,
    output: join(root, "blocked.mp3"),
    approveCost: false,
  }, { env, stateDir, fetchImpl }), /spend_not_approved/);
  assert.equal(calls, 0);

  const first = await synthesizeSpeech({
    textFile,
    output: join(root, "first.mp3"),
    approveCost: true,
  }, { env, stateDir, fetchImpl });
  assert.equal(first.cached, false);

  const secondOutput = join(root, "second.mp3");
  const second = await synthesizeSpeech({
    textFile,
    output: secondOutput,
    approveCost: false,
  }, {
    env: { ELEVENLABS_VOICE_ID: TEST_VOICE },
    stateDir,
    fetchImpl,
  });
  assert.equal(second.cached, true);
  assert.deepEqual(readFileSync(secondOutput), TEST_AUDIO);
  assert.equal(calls, 1);
});

test("text mode sends exact ElevenLabs audio to the selected HeyGen avatar", async (t) => {
  const { root, textFile } = workspace(t);
  const output = join(root, "avatar.mp4");
  const order = [];
  const result = await renderTextAvatarVideo({
    textFile,
    videoOutput: output,
    lookId: "selected-camera-look",
    aspect: "9:16",
    approveCreditSpend: true,
  }, {
    env: {
      ELEVENLABS_API: TEST_KEY,
      ELEVENLABS_VOICE_ID: TEST_VOICE,
    },
    config: { defaultAspect: "9:16", aspectLooks: {} },
    run: async (args) => {
      if (args[0] === "auth") {
        order.push("auth");
        return { data: { billing_type: "subscription", subscription: {} } };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
    synthesize: async (input) => {
      order.push("synthesize");
      assert.equal(input.text, TEST_TEXT);
      writeFileSync(input.output, TEST_AUDIO);
      return { ok: true, outputPath: input.output, cached: false };
    },
    render: async (input) => {
      order.push("render");
      assert.equal(input.lookId, "selected-camera-look");
      assert.deepEqual(readFileSync(input.audio), TEST_AUDIO);
      return { ok: true, outputPath: output, durationSec: 4 };
    },
  });
  assert.deepEqual(order, ["auth", "synthesize", "render"]);
  assert.equal(Object.hasOwn(result, "voiceId"), false);
  assert.equal(result.voiceProvider, "elevenlabs");
});
