import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as heygenClient from "../scripts/heygen-client.mjs";

const {
  MAX_AUDIO_BYTES,
  assertSubscription,
  buildDoctorSummary,
  cleanHeyGenEnv,
  configureDefault,
  listPrivateLooks,
  loadConfig,
  normalizeAudio,
  parseFlags,
  parseAuthStatus,
  probeVideo,
  resolveHeyGenBinary,
  renderAvatarVideo,
  resumeVideo,
} = heygenClient;

const CLIENT_PATH = fileURLToPath(new URL("../scripts/heygen-client.mjs", import.meta.url));

test("resolveHeyGenBinary использует локальный путь установщика или PATH", () => {
  assert.equal(resolveHeyGenBinary({
    homeDir: "/home/person",
    exists: (path) => path === "/home/person/.local/bin/heygen",
  }), "/home/person/.local/bin/heygen");
  assert.equal(resolveHeyGenBinary({
    homeDir: "/home/person",
    exists: () => false,
  }), "heygen");
});

test("cleanHeyGenEnv удаляет ключ и переопределение каталога вывода", () => {
  const env = cleanHeyGenEnv({
    PATH: "/bin",
    HEYGEN_API_KEY: "must-not-survive",
    HEYGEN_OUTPUT: "human",
  });

  assert.equal(env.PATH, "/bin");
  assert.equal("HEYGEN_API_KEY" in env, false);
  assert.equal("HEYGEN_OUTPUT" in env, false);
});

test("parseAuthStatus читает вложенные данные живой подписки", () => {
  const status = parseAuthStatus({
    credential: {
      type: "oauth",
      source: "file",
      user: { email: "private@example.com" },
    },
    data: {
      billing_type: "subscription",
      email: "private@example.com",
      subscription: {
        plan: "creator",
        credits: {
          premium_credits: { remaining: 594 },
          add_on_credits: { remaining: 60 },
        },
      },
    },
  });

  assert.deepEqual(status, {
    billingType: "subscription",
    credentialType: "oauth",
    plan: "creator",
    premiumCredits: 594,
    addOnCredits: 60,
  });
});

test("assertSubscription принимает только подписочный тип оплаты", () => {
  assert.equal(
    assertSubscription({ billingType: "subscription" }).billingType,
    "subscription",
  );
  assert.throws(
    () => assertSubscription({ billingType: "api" }),
    /subscription_required/,
  );
  assert.throws(
    () => assertSubscription({ billingType: "" }),
    /subscription_required/,
  );
});

test("buildDoctorSummary не возвращает личность аккаунта, токены и остаток кредитов", () => {
  const summary = buildDoctorSummary({
    cliVersion: "heygen version v0.8.1",
    credentialMode: "600",
    ffmpeg: true,
    ffprobe: true,
    authPayload: {
      credential: {
        type: "oauth",
        access_token: "secret-token",
        user: { email: "private@example.com" },
      },
      data: {
        billing_type: "subscription",
        email: "private@example.com",
        subscription: {
          plan: "creator",
          credits: {
            premium_credits: { remaining: 594 },
            add_on_credits: { remaining: 60 },
          },
        },
      },
    },
  });

  assert.deepEqual(summary, {
    ok: true,
    cliVersion: "v0.8.1",
    credentialMode: "600",
    credentialType: "oauth",
    billingType: "subscription",
    plan: "creator",
    ffmpeg: true,
    ffprobe: true,
  });
  assert.equal(JSON.stringify(summary).includes("private@example.com"), false);
  assert.equal(JSON.stringify(summary).includes("secret-token"), false);
});

test("listPrivateLooks раскрывает группы в конкретные образы для видео", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "avatar" && args[1] === "list") {
      return {
        data: [{ id: "group-1", name: "Тестовый ведущий", looks_count: 1 }],
        has_more: false,
      };
    }
    return {
      data: [{
        id: "look-1",
        group_id: "group-1",
        name: "Тестовый ведущий — основной",
        avatar_type: "digital_twin",
        preferred_orientation: "portrait",
        status: "completed",
        preview_image_url: "https://preview.example/look-1.jpg",
        image_width: 1080,
        image_height: 1920,
        default_voice_id: "voice-default",
      }],
      has_more: false,
    };
  };

  const looks = await listPrivateLooks({ run });

  assert.deepEqual(looks, [{
    groupId: "group-1",
    groupName: "Тестовый ведущий",
    lookId: "look-1",
    lookName: "Тестовый ведущий — основной",
    avatarType: "digital_twin",
    orientation: "portrait",
    status: "completed",
    previewImageUrl: "https://preview.example/look-1.jpg",
    width: 1080,
    height: 1920,
    defaultVoiceId: "voice-default",
  }]);
  assert.deepEqual(calls, [
    ["avatar", "list", "--ownership", "private", "--limit", "50"],
    [
      "avatar", "looks", "list",
      "--group-id", "group-1",
      "--ownership", "private",
      "--limit", "50",
    ],
  ]);
  assert.notEqual(looks[0].lookId, looks[0].groupId);
});

test("listPrivateLooks возвращает пустой каталог без личных групп", async () => {
  const looks = await listPrivateLooks({
    run: async () => ({ data: [], has_more: false }),
  });
  assert.deepEqual(looks, []);
});

test("listPrivateLooks отклоняет повреждённый каталог вместо догадки", async () => {
  await assert.rejects(
    listPrivateLooks({ run: async () => ({ unexpected: [] }) }),
    /avatar_catalog_invalid/,
  );
});

test("configureDefault сохраняет только актуальный личный образ с закрытыми правами", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heygen-config-test-"));
  const configPath = join(dir, "nested", "config.json");
  const looks = [{
    groupId: "group-1",
    groupName: "Тестовый ведущий",
    lookId: "look-1",
    lookName: "Тестовый ведущий — основной",
    avatarType: "digital_twin",
    orientation: "portrait",
    status: "completed",
  }];
  try {
    const saved = await configureDefault({
      lookId: "look-1",
      aspect: "9:16",
    }, {
      configPath,
      listLooks: async () => looks,
    });

    assert.deepEqual(saved, {
      version: 2,
      defaultGroupId: "group-1",
      defaultGroupName: "Тестовый ведущий",
      defaultLookId: "look-1",
      defaultLookName: "Тестовый ведущий — основной",
      defaultVoiceId: "",
      defaultVoiceName: "",
      aspectLooks: {
        "9:16": {
          groupId: "group-1",
          groupName: "Тестовый ведущий",
          lookId: "look-1",
          lookName: "Тестовый ведущий — основной",
        },
      },
      defaultAspect: "9:16",
      resolution: "1080p",
    });
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), saved);
    assert.equal((statSync(configPath).mode & 0o777).toString(8), "600");
    assert.deepEqual(loadConfig({ configPath }), saved);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig обновляет конфигурацию v1 без потери рабочего образа", () => {
  const dir = mkdtempSync(join(tmpdir(), "heygen-config-test-"));
  const configPath = join(dir, "config.json");
  try {
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      defaultLookId: "legacy-look",
      defaultLookName: "Тестовый ведущий",
      defaultAspect: "9:16",
      resolution: "1080p",
    }));

    assert.deepEqual(loadConfig({ configPath }), {
      version: 2,
      defaultGroupId: "",
      defaultGroupName: "",
      defaultLookId: "legacy-look",
      defaultLookName: "Тестовый ведущий",
      defaultVoiceId: "",
      defaultVoiceName: "",
      aspectLooks: {},
      defaultAspect: "9:16",
      resolution: "1080p",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configureDefault отклоняет неподдерживаемый формат и неизвестный образ", async () => {
  await assert.rejects(
    configureDefault({ lookId: "look-1", aspect: "1:1" }),
    /aspect_invalid/,
  );
  await assert.rejects(
    configureDefault({ lookId: "unknown", aspect: "9:16" }, {
      listLooks: async () => [{ lookId: "look-1" }],
    }),
    /private_look_not_found/,
  );
});

test("createAvatar требует явного разрешения до любого обращения к HeyGen", async () => {
  assert.equal(typeof heygenClient.createAvatar, "function");
  if (typeof heygenClient.createAvatar !== "function") return;
  let externalCalls = 0;
  await assert.rejects(
    heygenClient.createAvatar({
      type: "prompt",
      name: "Presenter",
      prompt: "A friendly presenter",
      approveCreditSpend: false,
    }, {
      run: async () => { externalCalls += 1; },
    }),
    /credit_spend_not_approved/,
  );
  assert.equal(externalCalls, 0);
});

test("createAvatar создаёт аватар по промпту и ждёт готовое превью", async () => {
  assert.equal(typeof heygenClient.createAvatar, "function");
  if (typeof heygenClient.createAvatar !== "function") return;
  const calls = [];
  let requestBody;
  let polls = 0;
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "auth") return { data: { billing_type: "subscription" } };
    if (args[0] === "avatar" && args[1] === "create") {
      requestBody = JSON.parse(readFileSync(args[3], "utf8"));
      return {
        data: {
          avatar_item: { id: "look-new", group_id: "group-new" },
          avatar_group: { id: "group-new", name: "Presenter" },
        },
      };
    }
    if (args[0] === "avatar" && args[1] === "looks") {
      polls += 1;
      if (polls === 1) {
        return { data: [{
          id: "look-new",
          group_id: "group-new",
          name: "Presenter",
          avatar_type: "photo_avatar",
          preferred_orientation: "portrait",
          status: "processing",
          preview_image_url: null,
          image_width: 0,
          image_height: 0,
        }] };
      }
      return { data: [{
        id: "look-new",
        group_id: "group-new",
        name: "Presenter",
        avatar_type: "photo_avatar",
        preferred_orientation: "portrait",
        status: "completed",
        preview_image_url: "https://preview.example/look-new.jpg",
        image_width: 1080,
        image_height: 1920,
      }] };
    }
    throw new Error(`unexpected_call: ${args.join(" ")}`);
  };

  const result = await heygenClient.createAvatar({
    type: "prompt",
    name: "Presenter",
    prompt: "A friendly presenter in a bright studio",
    aspect: "9:16",
    approveCreditSpend: true,
  }, {
    run,
    sleep: async () => {},
    maxAttempts: 3,
  });

  assert.deepEqual(requestBody, {
    type: "prompt",
    name: "Presenter",
    prompt: "A friendly presenter in a bright studio",
    aspect_ratio: "9:16",
  });
  assert.deepEqual(result, {
    ok: true,
    groupId: "group-new",
    groupName: "Presenter",
    lookId: "look-new",
    lookName: "Presenter",
    avatarType: "photo_avatar",
    orientation: "portrait",
    status: "completed",
    previewImageUrl: "https://preview.example/look-new.jpg",
  });
  assert.equal(polls, 2);
  assert.deepEqual(calls[0], ["auth", "status"]);
});

test("createAvatar загружает фото или Digital Twin-видео как личный ресурс", async () => {
  assert.equal(typeof heygenClient.createAvatar, "function");
  if (typeof heygenClient.createAvatar !== "function") return;
  const dir = mkdtempSync(join(tmpdir(), "heygen-avatar-source-test-"));
  try {
    for (const [type, extension] of [["photo", "jpg"], ["digital_twin", "mp4"]]) {
      const source = join(dir, `source.${extension}`);
      writeFileSync(source, "test-source");
      let requestBody;
      const run = async (args) => {
        if (args[0] === "auth") return { data: { billing_type: "subscription" } };
        if (args[0] === "asset") {
          assert.deepEqual(args, ["asset", "create", "--file", source]);
          return { data: { asset_id: `asset-${type}` } };
        }
        if (args[0] === "avatar" && args[1] === "create") {
          requestBody = JSON.parse(readFileSync(args[3], "utf8"));
          return {
            data: {
              avatar_item: { id: `look-${type}`, group_id: "group-existing" },
              avatar_group: { id: "group-existing", name: "Тестовый ведущий" },
            },
          };
        }
        if (args[0] === "avatar" && args[1] === "looks") {
          return { data: [{
            id: `look-${type}`,
            group_id: "group-existing",
            name: `Тестовый ведущий ${type}`,
            avatar_type: type === "photo" ? "photo_avatar" : "digital_twin",
            preferred_orientation: "landscape",
            status: "completed",
            preview_image_url: `https://preview.example/${type}.jpg`,
            image_width: 1920,
            image_height: 1080,
          }] };
        }
        throw new Error(`unexpected_call: ${args.join(" ")}`);
      };

      await heygenClient.createAvatar({
        type,
        name: `Тестовый ведущий ${type}`,
        file: source,
        groupId: "group-existing",
        approveCreditSpend: true,
      }, { run, sleep: async () => {} });

      assert.deepEqual(requestBody, {
        type,
        name: `Тестовый ведущий ${type}`,
        file: { type: "asset_id", asset_id: `asset-${type}` },
        avatar_group_id: "group-existing",
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createAvatar отклоняет неподдерживаемый или слишком большой файл до обращения к HeyGen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heygen-avatar-validation-test-"));
  let externalCalls = 0;
  const run = async () => {
    externalCalls += 1;
    throw new Error("external_call_must_not_run");
  };

  try {
    const wrongType = join(dir, "portrait.txt");
    writeFileSync(wrongType, "not-an-image");
    await assert.rejects(
      heygenClient.createAvatar({
        type: "photo",
        name: "Presenter",
        file: wrongType,
        approveCreditSpend: true,
      }, { run }),
      /avatar_file_type_invalid/,
    );

    const oversizedVideo = join(dir, "twin.mp4");
    writeFileSync(oversizedVideo, "");
    truncateSync(oversizedVideo, (32 * 1024 * 1024) + 1);
    await assert.rejects(
      heygenClient.createAvatar({
        type: "digital_twin",
        name: "Presenter",
        file: oversizedVideo,
        approveCreditSpend: true,
      }, { run }),
      /avatar_file_too_large/,
    );
    assert.equal(externalCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createAvatar сразу сообщает об ожидании согласия и не опрашивает неготовый Digital Twin", async () => {
  let lookPolls = 0;
  const result = await heygenClient.createAvatar({
    type: "prompt",
    name: "Presenter",
    prompt: "A friendly presenter",
    approveCreditSpend: true,
  }, {
    run: async (args) => {
      if (args[0] === "auth") return { data: { billing_type: "subscription" } };
      if (args[0] === "avatar" && args[1] === "create") {
        return {
          data: {
            avatar_item: null,
            avatar_group: {
              id: "group-new",
              name: "Presenter",
              status: "pending_consent",
            },
          },
        };
      }
      lookPolls += 1;
      throw new Error("avatar_look_poll_must_not_run");
    },
  });

  assert.deepEqual(result, {
    ok: true,
    groupId: "group-new",
    groupName: "Presenter",
    lookId: "",
    lookName: "Presenter",
    avatarType: "",
    orientation: "",
    status: "pending_consent",
    previewImageUrl: "",
    requiresConsent: true,
  });
  assert.equal(lookPolls, 0);
});

test("createAvatarConsent возвращает браузерную ссылку только после явного разрешения", async () => {
  assert.equal(typeof heygenClient.createAvatarConsent, "function");
  if (typeof heygenClient.createAvatarConsent !== "function") return;
  let calls = 0;
  await assert.rejects(
    heygenClient.createAvatarConsent({ groupId: "group-1", approve: false }, {
      run: async () => { calls += 1; },
    }),
    /avatar_consent_not_approved/,
  );
  assert.equal(calls, 0);

  const result = await heygenClient.createAvatarConsent({
    groupId: "group-1",
    approve: true,
  }, {
    run: async (args) => {
      calls += 1;
      if (args[0] === "auth") return { data: { billing_type: "subscription" } };
      assert.deepEqual(args, ["avatar", "consent", "create", "group-1"]);
      return {
        data: {
          avatar_group: { id: "group-1", name: "Тестовый ведущий", status: "pending_consent" },
          url: "https://app.heygen.com/consent/example",
        },
      };
    },
  });

  assert.deepEqual(result, {
    ok: true,
    groupId: "group-1",
    groupName: "Тестовый ведущий",
    status: "pending_consent",
    consentUrl: "https://app.heygen.com/consent/example",
  });
});

test("listVoices возвращает личные голоса с превью без данных аккаунта", async () => {
  assert.equal(typeof heygenClient.listVoices, "function");
  if (typeof heygenClient.listVoices !== "function") return;
  const calls = [];
  const voices = await heygenClient.listVoices({
    type: "private",
    language: "Russian",
    gender: "male",
    limit: 3,
  }, {
    run: async (args) => {
      calls.push(args);
      if (args[0] === "auth") {
        return { data: { billing_type: "subscription", email: "private@example.com" } };
      }
      return { data: [{
        voice_id: "voice-1",
        name: "Russian warm voice",
        language: "Russian",
        gender: "male",
        type: "private",
        preview_audio_url: "https://preview.example/voice-1.mp3",
        support_pause: true,
        support_locale: true,
      }] };
    },
  });

  assert.deepEqual(voices, [{
    voiceId: "voice-1",
    voiceName: "Russian warm voice",
    language: "Russian",
    gender: "male",
    type: "private",
    previewAudioUrl: "https://preview.example/voice-1.mp3",
  }]);
  assert.deepEqual(calls, [
    ["auth", "status"],
    [
      "voice", "list", "--type", "private",
      "--language", "Russian", "--gender", "male", "--limit", "3",
    ],
  ]);
  assert.equal(JSON.stringify(voices).includes("private@example.com"), false);
});

test("designVoices возвращает три подходящих голоса с превью", async () => {
  assert.equal(typeof heygenClient.designVoices, "function");
  if (typeof heygenClient.designVoices !== "function") return;
  const calls = [];
  const choices = await heygenClient.designVoices({
    prompt: "Warm confident Russian male speaker",
    locale: "ru-RU",
    gender: "male",
    seed: 2,
  }, {
    run: async (args) => {
      calls.push(args);
      if (args[0] === "auth") return { data: { billing_type: "subscription" } };
      return {
        data: {
          seed: 2,
          voices: [1, 2, 3].map((number) => ({
            voice_id: `voice-${number}`,
            name: `Option ${number}`,
            language: "Russian",
            gender: "male",
            type: "public",
            preview_audio_url: `https://preview.example/${number}.mp3`,
          })),
        },
      };
    },
  });

  assert.equal(choices.length, 3);
  assert.equal(choices[0].previewAudioUrl, "https://preview.example/1.mp3");
  assert.deepEqual(calls[1], [
    "voice", "create",
    "--prompt", "Warm confident Russian male speaker",
    "--seed", "2",
    "--gender", "male",
    "--locale", "ru-RU",
  ]);
});

test("configureVoice проверяет и сохраняет голос без потери личности аватара", async () => {
  assert.equal(typeof heygenClient.configureVoice, "function");
  if (typeof heygenClient.configureVoice !== "function") return;
  const dir = mkdtempSync(join(tmpdir(), "heygen-voice-config-test-"));
  const configPath = join(dir, "config.json");
  try {
    writeFileSync(configPath, JSON.stringify({
      version: 2,
      defaultGroupId: "group-1",
      defaultGroupName: "Тестовый ведущий",
      defaultLookId: "look-1",
      defaultLookName: "Тестовый ведущий 9:16",
      defaultVoiceId: "",
      defaultVoiceName: "",
      defaultAspect: "9:16",
      resolution: "1080p",
    }));
    const saved = await heygenClient.configureVoice({ voiceId: "voice-1" }, {
      configPath,
      run: async (args) => {
        if (args[0] === "auth") return { data: { billing_type: "subscription" } };
        return { data: {
          voice_id: "voice-1",
          name: "My Russian voice",
          language: "Russian",
          gender: "male",
          preview_audio_url: "https://preview.example/voice-1.mp3",
          support_pause: true,
        } };
      },
    });

    assert.equal(saved.defaultGroupId, "group-1");
    assert.equal(saved.defaultLookId, "look-1");
    assert.equal(saved.defaultVoiceId, "voice-1");
    assert.equal(saved.defaultVoiceName, "My Russian voice");
    assert.equal((statSync(configPath).mode & 0o777).toString(8), "600");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadVoicePreview сохраняет рабочее превью по абсолютному пути", async () => {
  assert.equal(typeof heygenClient.downloadVoicePreview, "function");
  if (typeof heygenClient.downloadVoicePreview !== "function") return;
  const dir = mkdtempSync(join(tmpdir(), "heygen-voice-preview-test-"));
  const output = join(dir, "voice.mp3");
  try {
    const result = await heygenClient.downloadVoicePreview({
      voiceId: "voice-1",
      output,
    }, {
      run: async (args) => {
        if (args[0] === "auth") return { data: { billing_type: "subscription" } };
        return { data: {
          voice_id: "voice-1",
          name: "My Russian voice",
          preview_audio_url: "https://preview.example/voice-1.mp3",
          support_pause: true,
        } };
      },
      download: async (url, target) => {
        assert.equal(url, "https://preview.example/voice-1.mp3");
        writeFileSync(target, Buffer.from("audio-preview"));
      },
    });

    assert.deepEqual(result, {
      ok: true,
      voiceId: "voice-1",
      voiceName: "My Russian voice",
      outputPath: output,
      sizeBytes: 13,
    });
    assert.equal(readFileSync(output, "utf8"), "audio-preview");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderAvatarVideo останавливается до внешних вызовов без разрешения на кредиты", async () => {
  let externalCalls = 0;
  await assert.rejects(
    renderAvatarVideo({
      audio: "/tmp/voice.ogg",
      output: "/tmp/result.mp4",
      approveCreditSpend: false,
    }, {
      run: async () => { externalCalls += 1; },
      normalize: async () => { externalCalls += 1; },
    }),
    /credit_spend_not_approved/,
  );
  assert.equal(externalCalls, 0);
});

test("renderAvatarVideo загружает аудио, использует образ и скачивает результат один раз", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "heygen-state-test-"));
  const output = join(stateDir, "result", "avatar.mp4");
  const calls = [];
  let requestBody;
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "auth") {
      return { data: { billing_type: "subscription", subscription: { plan: "creator" } } };
    }
    if (args[0] === "asset") {
      return {
        data: {
          asset_id: "asset-1",
          url: "https://signed.example/audio",
          mime_type: "audio/mpeg",
          size_bytes: 1000,
        },
      };
    }
    if (args[0] === "video" && args[1] === "create") {
      requestBody = JSON.parse(readFileSync(args[3], "utf8"));
      return { data: { video_id: "video-1", status: "waiting", output_format: "mp4" } };
    }
    if (args[0] === "video" && args[1] === "get") {
      return { data: { id: "video-1", status: "completed" } };
    }
    if (args[0] === "video" && args[1] === "download") {
      writeFileSync(args[4], "downloaded-video");
      return { asset: "video", path: args[4] };
    }
    throw new Error(`unexpected_call: ${args.join(" ")}`);
  };
  try {
    const result = await renderAvatarVideo({
      audio: "/tmp/voice.ogg",
      lookId: "look-1",
      aspect: "9:16",
      output,
      approveCreditSpend: true,
    }, {
      run,
      normalize: async () => ({ path: "/tmp/voice.mp3", sizeBytes: 1000 }),
      probe: async () => ({ durationSec: 4, sizeBytes: 200000, width: 1080, height: 1920 }),
      sleep: async () => {},
      stateDir,
    });

    assert.deepEqual(requestBody, {
      type: "avatar",
      avatar_id: "look-1",
      audio_asset_id: "asset-1",
      resolution: "1080p",
      aspect_ratio: "9:16",
    });
    assert.deepEqual(result, {
      ok: true,
      videoId: "video-1",
      outputPath: output,
      durationSec: 4,
      sizeBytes: 200000,
      width: 1080,
      height: 1920,
    });
    assert.equal(calls.filter((args) => args[0] === "asset").length, 1);
    assert.equal(
      calls.filter((args) => args[0] === "video" && args[1] === "create").length,
      1,
    );
    assert.equal(
      calls.filter((args) => args[0] === "video" && args[1] === "download").length,
      1,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("renderAvatarVideo обновляет сменяемый образ по стабильной группе и формату", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "heygen-state-test-"));
  const output = join(stateDir, "result", "avatar-landscape.mp4");
  let requestBody;
  const run = async (args) => {
    if (args[0] === "auth") {
      return { data: { billing_type: "subscription", subscription: { plan: "creator" } } };
    }
    if (args[0] === "asset") return { data: { asset_id: "asset-1" } };
    if (args[0] === "video" && args[1] === "create") {
      requestBody = JSON.parse(readFileSync(args[3], "utf8"));
      return { data: { video_id: "video-1", status: "waiting" } };
    }
    if (args[0] === "video" && args[1] === "get") {
      return { data: { id: "video-1", status: "completed" } };
    }
    if (args[0] === "video" && args[1] === "download") {
      writeFileSync(args[4], "downloaded-video");
      return { asset: "video", path: args[4] };
    }
    throw new Error(`unexpected_call: ${args.join(" ")}`);
  };
  try {
    await renderAvatarVideo({
      audio: "/tmp/voice.ogg",
      aspect: "16:9",
      output,
      approveCreditSpend: true,
    }, {
      config: {
        version: 2,
        defaultGroupId: "group-1",
        defaultGroupName: "Тестовый ведущий",
        defaultLookId: "deleted-old-look",
        defaultLookName: "Тестовый ведущий",
        defaultVoiceId: "",
        defaultVoiceName: "",
        defaultAspect: "9:16",
        resolution: "1080p",
      },
      listLooks: async () => [
        {
          groupId: "group-1",
          groupName: "Тестовый ведущий",
          lookId: "fresh-portrait-look",
          lookName: "Тестовый ведущий 9:16",
          orientation: "portrait",
          status: "completed",
        },
        {
          groupId: "group-landscape",
          groupName: "Горизонтальная студия",
          lookId: "fresh-landscape-look",
          lookName: "Тестовый ведущий 16:9",
          orientation: "landscape",
          status: "completed",
        },
      ],
      run,
      normalize: async () => ({ path: "/tmp/voice.mp3", sizeBytes: 1000 }),
      probe: async () => ({ durationSec: 4, sizeBytes: 200000, width: 1920, height: 1080 }),
      sleep: async () => {},
      stateDir,
    });

    assert.equal(requestBody.avatar_id, "fresh-landscape-look");
    assert.equal(requestBody.aspect_ratio, "16:9");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("renderAvatarVideo отклоняет слишком большое аудио до загрузки", async () => {
  const calls = [];
  await assert.rejects(
    renderAvatarVideo({
      audio: "/tmp/huge.wav",
      lookId: "look-1",
      aspect: "9:16",
      output: "/tmp/result.mp4",
      approveCreditSpend: true,
    }, {
      run: async (args) => {
        calls.push(args);
        return { data: { billing_type: "subscription" } };
      },
      normalize: async () => ({
        path: "/tmp/huge.mp3",
        sizeBytes: MAX_AUDIO_BYTES + 1,
      }),
    }),
    /audio_too_large/,
  );
  assert.deepEqual(calls, [["auth", "status"]]);
});

test("renderAvatarVideo останавливается при ошибочном или неизвестном статусе", async () => {
  for (const [status, expected] of [
    ["failed", /video_failed/],
    ["mystery", /video_status_unknown/],
  ]) {
    const stateDir = mkdtempSync(join(tmpdir(), "heygen-state-test-"));
    const run = async (args) => {
      if (args[0] === "auth") return { data: { billing_type: "subscription" } };
      if (args[0] === "asset") return { data: { asset_id: "asset-1" } };
      if (args[1] === "create") return { data: { video_id: "video-1", status: "waiting" } };
      if (args[1] === "get") {
        return { data: { id: "video-1", status, failure_code: "render_error" } };
      }
      throw new Error("download_must_not_run");
    };
    try {
      await assert.rejects(
        renderAvatarVideo({
          audio: "/tmp/voice.ogg",
          lookId: "look-1",
          output: "/tmp/result.mp4",
          approveCreditSpend: true,
        }, {
          run,
          normalize: async () => ({ path: "/tmp/voice.mp3", sizeBytes: 1000 }),
          sleep: async () => {},
          stateDir,
        }),
        expected,
      );
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
});

test("resumeVideo останавливается после четырёх нечитаемых ответов статуса", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "heygen-state-test-"));
  let getCalls = 0;
  const run = async (args) => {
    if (args[0] === "auth") return { data: { billing_type: "subscription" } };
    if (args[1] === "get") {
      getCalls += 1;
      throw new Error("network_down");
    }
    throw new Error("unexpected_call");
  };

  try {
    await assert.rejects(
      resumeVideo({ videoId: "video-1", output: "/tmp/result.mp4" }, {
        run,
        sleep: async () => {},
        maxAttempts: 20,
        stateDir,
      }),
      /auth_or_network_unreadable/,
    );
    assert.equal(getCalls, 4);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("resumeVideo завершает ожидание без создания второго платного видео", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "heygen-state-test-"));
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "auth") return { data: { billing_type: "subscription" } };
    if (args[1] === "get") return { data: { id: "video-1", status: "processing" } };
    throw new Error("unexpected_call");
  };

  try {
    await assert.rejects(
      resumeVideo({ videoId: "video-1", output: "/tmp/result.mp4" }, {
        run,
        sleep: async () => {},
        maxAttempts: 2,
        stateDir,
      }),
      /video_timeout/,
    );
    assert.equal(calls.some((args) => args[1] === "create"), false);
    assert.equal(calls.filter((args) => args[1] === "get").length, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("resumeVideo закрывает права на каталог и скачанный ролик", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heygen-private-video-test-"));
  const output = join(dir, "result", "avatar.mp4");
  const stateDir = join(dir, "state");
  const run = async (args) => {
    if (args[0] === "auth") return { data: { billing_type: "subscription" } };
    if (args[0] === "video" && args[1] === "get") {
      return { data: { id: "video-private", status: "completed" } };
    }
    if (args[0] === "video" && args[1] === "download") {
      writeFileSync(output, "private-video", { mode: 0o644 });
      chmodSync(output, 0o644);
      return { path: output };
    }
    throw new Error(`unexpected_call: ${args.join(" ")}`);
  };

  try {
    await resumeVideo({ videoId: "video-private", output }, {
      run,
      probe: async () => ({ durationSec: 1, sizeBytes: 200000, width: 1080, height: 1920 }),
      sleep: async () => {},
      stateDir,
    });
    assert.equal((statSync(join(dir, "result")).mode & 0o777).toString(8), "700");
    assert.equal((statSync(output).mode & 0o777).toString(8), "600");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resumeVideo не меняет права существующего каталога результата", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heygen-existing-output-test-"));
  const outputDir = join(dir, "shared");
  const output = join(outputDir, "avatar.mp4");
  const stateDir = join(dir, "state");
  mkdirSync(outputDir, { mode: 0o755 });
  chmodSync(outputDir, 0o755);
  const run = async (args) => {
    if (args[0] === "auth") return { data: { billing_type: "subscription" } };
    if (args[0] === "video" && args[1] === "get") {
      return { data: { id: "video-shared", status: "completed" } };
    }
    if (args[0] === "video" && args[1] === "download") {
      writeFileSync(output, "private-video", { mode: 0o644 });
      return { path: output };
    }
    throw new Error(`unexpected_call: ${args.join(" ")}`);
  };

  try {
    await resumeVideo({ videoId: "video-shared", output }, {
      run,
      probe: async () => ({ durationSec: 1, sizeBytes: 200000, width: 1080, height: 1920 }),
      sleep: async () => {},
      stateDir,
    });
    assert.equal((statSync(outputDir).mode & 0o777).toString(8), "755");
    assert.equal((statSync(output).mode & 0o777).toString(8), "600");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseFlags отличает флаг разрешения от параметров со значением", () => {
  assert.deepEqual(parseFlags([
    "--audio", "/tmp/voice.ogg",
    "--aspect", "9:16",
    "--approve-credit-spend",
  ]), {
    audio: "/tmp/voice.ogg",
    aspect: "9:16",
    "approve-credit-spend": true,
  });
  assert.throws(() => parseFlags(["--audio"]), /missing_value/);
});

test("справка CLI сохраняет старые команды и показывает команды аватара и голоса", () => {
  const payload = JSON.parse(execFileSync(process.execPath, [CLIENT_PATH, "help"], {
    encoding: "utf8",
  }));
  assert.deepEqual(payload.commands, [
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
  ]);
});

test("normalizeAudio создаёт mono MP3 44,1 кГц и не изменяет исходник", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heygen-media-test-"));
  const source = join(dir, "source.wav");
  const original = Buffer.from("source-sentinel");
  try {
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "0.5", "-y", source,
    ]);
    const sourceBefore = readFileSync(source);

    const result = await normalizeAudio(source, { workDir: join(dir, "work") });
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_name,sample_rate,channels",
      "-of", "json",
      result.path,
    ], { encoding: "utf8" }));

    assert.equal(result.path, join(dir, "work", "voice.mp3"));
    assert.ok(result.sizeBytes > 0 && result.sizeBytes <= MAX_AUDIO_BYTES);
    assert.deepEqual(probe.streams[0], {
      codec_name: "mp3",
      sample_rate: "44100",
      channels: 1,
    });
    assert.deepEqual(readFileSync(source), sourceBefore);
    assert.notDeepEqual(readFileSync(source), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeAudio принимает голосовые OGG Opus и M4A", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heygen-recorded-voice-test-"));
  try {
    for (const [name, codec] of [["voice.ogg", "libopus"], ["voice.m4a", "aac"]]) {
      const source = join(dir, name);
      execFileSync("ffmpeg", [
        "-v", "error",
        "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000",
        "-t", "0.4", "-c:a", codec, "-y", source,
      ]);
      const result = await normalizeAudio(source, {
        workDir: join(dir, `normalized-${name}`),
      });
      const probe = JSON.parse(execFileSync("ffprobe", [
        "-v", "error",
        "-show_entries", "stream=codec_name,sample_rate,channels",
        "-of", "json",
        result.path,
      ], { encoding: "utf8" }));
      assert.deepEqual(probe.streams[0], {
        codec_name: "mp3",
        sample_rate: "44100",
        channels: 1,
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeVideo принимает настоящий MP4 и отклоняет файл-подделку", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heygen-video-test-"));
  const video = join(dir, "video.mp4");
  const impostor = join(dir, "not-video.mp4");
  try {
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25",
      "-t", "2", "-c:v", "libx264", "-b:v", "1M",
      "-pix_fmt", "yuv420p", "-y", video,
    ]);
    writeFileSync(impostor, "not a video");

    const result = await probeVideo(video);
    assert.equal(result.width, 640);
    assert.equal(result.height, 360);
    assert.equal(result.codec, "h264");
    assert.ok(result.durationSec >= 1.9 && result.durationSec <= 2.1);
    assert.ok(result.sizeBytes > 100 * 1024);
    await assert.rejects(probeVideo(impostor), /video_file_too_small/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
