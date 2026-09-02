import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function collectFiles(relativePath) {
  const absolutePath = join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) return [];
  if (statSync(absolutePath).isFile()) return [absolutePath];
  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) =>
    collectFiles(join(relativePath, entry.name))
  );
}

test("публичный скилл имеет отдельное имя и стандартные метаданные", () => {
  const skill = read("SKILL.md");
  assert.match(skill, /^name: heygen-avatar-oauth$/m);
  assert.match(skill, /^license: MIT$/m);
  assert.match(skill, /^compatibility: .+$/m);
});

test("публичный комплект содержит русскую документацию и файлы сопровождения", () => {
  const required = [
    "README.md",
    "LICENSE",
    "NOTICE.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "ARCHITECTURE.md",
    "TESTING.md",
    "CHANGELOG.md",
    "DECISIONS.md",
    "docs/INSTALL-CODEX.md",
    "docs/INSTALL-CLAUDE-CODE.md",
    "scripts/install.sh",
    "package.json",
    ".github/workflows/ci.yml",
  ];

  for (const path of required) {
    assert.equal(existsSync(join(repoRoot, path)), true, `Нет обязательного файла: ${path}`);
  }
  const russianLetters = read("README.md").match(/[А-Яа-яЁё]/g) ?? [];
  assert.ok(russianLetters.length > 500, "README должен быть подробным и русскоязычным");
});

test("внутренние ссылки русской документации ведут на существующие файлы", () => {
  const markdownFiles = [
    ...collectFiles("README.md"),
    ...collectFiles("NOTICE.md"),
    ...collectFiles("SECURITY.md"),
    ...collectFiles("CONTRIBUTING.md"),
    ...collectFiles("ARCHITECTURE.md"),
    ...collectFiles("TESTING.md"),
    ...collectFiles("CHANGELOG.md"),
    ...collectFiles("DECISIONS.md"),
    ...collectFiles("docs"),
  ];

  for (const file of markdownFiles) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      assert.equal(
        existsSync(resolve(dirname(file), target)),
        true,
        `Нерабочая ссылка ${target} в ${file}`,
      );
    }
  }
});

test("публикуемые исходники не содержат личные данные или секреты", () => {
  const publishableRoots = [
    "SKILL.md", "README.md", "LICENSE", "NOTICE.md", "SECURITY.md",
    "CONTRIBUTING.md", "ARCHITECTURE.md", "TESTING.md", "CHANGELOG.md",
    "DECISIONS.md", "AGENTS.md", "CLAUDE.md", ".env.example", ".gitignore",
    "package.json", "package-lock.json", "scripts", "tests", "docs",
    "instructions", ".github",
  ];
  const files = publishableRoots.flatMap(collectFiles);
  const forbidden = [
    ["личный путь владельца", ["/Users/macbook", "ledovskih"].join("")],
    ["личное имя аватара", ["Оци", "фролог"].join("")],
    ["личное имя образа", ["Дима", " в студии"].join("")],
  ];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const [label, value] of forbidden) {
      assert.equal(content.includes(value), false, `${label}: ${file}`);
    }
    assert.doesNotMatch(content, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    assert.doesNotMatch(content, /\b(?:sk|hg)_[A-Za-z0-9_-]{20,}\b/);
  }
});

for (const agent of ["codex", "claude"]) {
  test(`установщик ставит скилл для ${agent} и не переносит авторизацию`, () => {
    const fakeHome = mkdtempSync(join(tmpdir(), `heygen-avatar-oauth-${agent}-`));
    try {
      const result = spawnSync("bash", [join(repoRoot, "scripts/install.sh"), agent], {
        cwd: repoRoot,
        env: { ...process.env, HOME: fakeHome },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const base = agent === "codex" ? ".agents/skills" : ".claude/skills";
      const installed = join(fakeHome, base, "heygen-avatar-oauth");
      assert.equal(existsSync(join(installed, "SKILL.md")), true);
      assert.equal(existsSync(join(installed, "scripts/heygen-client.mjs")), true);
      assert.equal(existsSync(join(installed, "config.json")), false);
      assert.equal(existsSync(join(installed, "credentials")), false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
}
