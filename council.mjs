#!/usr/bin/env node
/*
 * council-cli — convene a panel of AI CLIs you already pay for.
 *
 * No API keys. No extra subscriptions. It shells out to the logged-in CLIs
 * you already have (Claude Code, Codex, Gemini, …), asks each the same
 * question in parallel, and writes every answer to disk so you can compare.
 *
 * Privacy by default: API-key-style env vars are stripped from the child
 * processes, and your verbatim question is kept separate from framing.
 *
 * MIT licensed. See LICENSE.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const OUT_ROOT = path.join(ROOT, "council-runs");
const DEFAULT_TIMEOUT_MS = Number(process.env.COUNCIL_TIMEOUT_MS || 180000);

// Built-in adapters. Override the binary with the matching *_BIN env var.
// Add your own by extending this map; each adapter turns a prompt into
// { bin, args } for a read-only, one-shot CLI call.
const ADAPTERS = {
  claude: {
    bin: () => process.env.CLAUDE_BIN || "claude",
    args: (prompt, model) => {
      const a = ["-p", prompt, "--output-format", "text"];
      if (model) a.push("--model", model);
      return a;
    },
    role: "You weigh long context, human direction, and strategic judgment.",
  },
  codex: {
    bin: () => process.env.CODEX_BIN || "codex",
    args: (prompt, model) => {
      const a = ["exec", "--skip-git-repo-check", "--color", "never", "--sandbox", "read-only"];
      if (model) a.push("-m", model);
      a.push(prompt);
      return a;
    },
    role: "You weigh implementation feasibility, system design, and automation risk.",
  },
  gemini: {
    bin: () => process.env.GEMINI_BIN || "gemini",
    args: (prompt, model) => {
      const a = [];
      if (model) a.push("--model", model);
      a.push("-p", prompt, "--output-format", "text");
      return a;
    },
    role: "You weigh broad comparison, fresh information, and external research.",
  },
};

const MODELS = {
  claude: process.env.COUNCIL_CLAUDE_MODEL || "",
  codex: process.env.COUNCIL_CODEX_MODEL || "",
  gemini: process.env.COUNCIL_GEMINI_MODEL || "",
};

function parseArgs(argv) {
  const opts = {
    participants: null,
    question: "",
    questionFile: "",
    contextFile: "",
    style: (process.env.COUNCIL_STYLE || "divergent").toLowerCase(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--participants") opts.participants = (argv[++i] || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (arg === "--style") opts.style = (argv[++i] || opts.style).toLowerCase();
    else if (arg === "--context-file") opts.contextFile = argv[++i] || "";
    else if (arg === "--question-file") opts.questionFile = argv[++i] || "";
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(argv[++i] || opts.timeoutMs);
    else rest.push(arg);
  }
  if (!opts.participants) opts.participants = Object.keys(ADAPTERS);
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) opts.timeoutMs = DEFAULT_TIMEOUT_MS;
  opts.participants = [...new Set(opts.participants)];
  opts.question = rest.join(" ").trim();
  return opts;
}

function usage() {
  return [
    'Usage: council [options] "your question"',
    "",
    "Options:",
    "  --participants claude,codex,gemini   Which CLIs to convene. Default: all built-in.",
    "  --style divergent|consensus|audit    Prompt framing. Default: divergent.",
    "  --question-file <path>               Your verbatim question (kept exactly as written).",
    "  --context-file <path>                Sanitized background/framing, kept separate.",
    "  --timeout-ms <n>                     Per-participant timeout (default 180000).",
    "  --help                               Show this help.",
    "",
    "Why the split: council keeps your raw question untouched so each model answers",
    "what you actually asked, not a paraphrase. Put summaries/framing in the context file.",
    "",
    "Privacy: *_API_KEY-style env vars are removed from every child process.",
    "Missing CLIs are skipped with a note, not fatal.",
  ].join("\n");
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "question";
}

function timestamp() {
  // Note: uses local time. Deterministic formatting not required for filenames.
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function buildPrompt(participant, input, style) {
  const role = ADAPTERS[participant]?.role || "You are an independent advisor.";
  if (style === "consensus") {
    return [
      role,
      "Answer the question below with your independent opinion. Be concise.",
      "Include: (1) core judgment, (2) the easiest risk to miss, (3) the next action you recommend.",
      "Do not modify any files. Answer only.",
      input.context ? `\n[context]\n${input.context}` : "",
      `\n[question]\n${input.question}`,
    ].filter(Boolean).join("\n");
  }
  if (style === "audit") {
    return [
      role,
      "You are auditing the quality of a council request.",
      "First check whether the question or context nudges answers in a particular direction.",
      "If the question looks translated, summarized, or rewritten, say so.",
      "Then answer the question directly and independently.",
      "Do not modify files. Do not assume paid API or external actions.",
      `\n[context]\n${input.context || "(none provided)"}`,
      `\n[verbatim question]\n${input.question}`,
    ].join("\n");
  }
  // divergent (default)
  return [
    role,
    "Below is a council request. The context packet is reference only — you do not have to agree with it.",
    "Answer the user's verbatim question directly.",
    "The verbatim question should be the user's exact last question. If it looks translated, summarized, or turned into a checklist, point that out first.",
    "Feel free to lead with disagreement, missing assumptions, a better framing, or what still needs checking.",
    "Answer in free form. No fixed outline, no length limit.",
    "",
    "Do not: modify files; invent personal/org/path/secret details not in the input; assume paid API or external execution.",
    `\n[context packet]\n${input.context || "(none provided)"}`,
    `\n[verbatim question]\n${input.question}`,
  ].join("\n");
}

// Strip API-key-style credentials so a subscription CLI never sees them.
function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.endsWith("_API_KEY") || key.endsWith("_API_KEYS") || key.endsWith("_TOKEN")) delete env[key];
  }
  return { ...env, NO_COLOR: "1", TERM: "dumb" };
}

function run(participant, prompt, timeoutMs) {
  const adapter = ADAPTERS[participant];
  if (!adapter) return Promise.resolve({ participant, ok: false, skipped: true, reason: `unknown participant: ${participant}` });
  const bin = adapter.bin();
  const args = adapter.args(prompt, MODELS[participant]);
  return new Promise((resolve) => {
    const start = Date.now();
    let child;
    try {
      child = spawn(bin, args, { env: childEnv() });
    } catch (err) {
      resolve({ participant, ok: false, skipped: true, reason: `${bin} not runnable: ${err.message}` });
      return;
    }
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      const missing = err.code === "ENOENT";
      resolve({ participant, ok: false, skipped: missing, reason: missing ? `${bin} not found (skipped). Set ${participant.toUpperCase()}_BIN or install it.` : err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ participant, ok: code === 0, code, durationMs: Date.now() - start, response: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(usage()); return; }

  const questionFromFile = opts.questionFile ? await readFile(path.resolve(ROOT, opts.questionFile), "utf8") : "";
  const context = opts.contextFile ? await readFile(path.resolve(ROOT, opts.contextFile), "utf8") : "";
  const question = (questionFromFile || opts.question).trim();
  if (!question) { console.error("No question provided.\n"); console.log(usage()); process.exit(1); }

  const input = { question, context: context.trim() };
  const outDir = path.join(OUT_ROOT, `${timestamp()}-${slugify(question)}`);
  await mkdir(path.join(outDir, "prompts"), { recursive: true });
  await writeFile(path.join(outDir, "question.md"), question + "\n");
  if (input.context) await writeFile(path.join(outDir, "context.md"), input.context + "\n");

  console.log(`Convening: ${opts.participants.join(", ")}  (style: ${opts.style})`);
  const results = await Promise.all(
    opts.participants.map(async (p) => {
      const prompt = buildPrompt(p, input, opts.style);
      await writeFile(path.join(outDir, "prompts", `${p}.md`), prompt + "\n");
      const r = await run(p, prompt, opts.timeoutMs);
      const body = r.skipped
        ? `# ${p}\n\nskipped: ${r.reason}\n`
        : `# ${p}\n\nok: ${r.ok}\nexit_code: ${r.code}\nduration_ms: ${r.durationMs}\n\n## Response\n\n${r.response || "(empty)"}\n\n## Stderr\n\n${r.stderr ? "```\n" + r.stderr + "\n```" : "(empty)"}\n`;
      await writeFile(path.join(outDir, `${p}.md`), body);
      const tag = r.skipped ? "SKIP" : r.ok ? "ok" : "FAIL";
      console.log(`  [${tag}] ${p}${r.durationMs ? ` (${(r.durationMs / 1000).toFixed(1)}s)` : ""}${r.reason ? " — " + r.reason : ""}`);
      return { participant: p, ...r };
    }),
  );

  const index = [
    `# Council run\n`,
    `question: ${question.slice(0, 200)}`,
    `style: ${opts.style}`,
    "",
    "| participant | status | duration |",
    "| --- | --- | --- |",
    ...results.map((r) => `| ${r.participant} | ${r.skipped ? "skipped" : r.ok ? "ok" : "failed"} | ${r.durationMs ? (r.durationMs / 1000).toFixed(1) + "s" : "-"} |`),
    "",
  ].join("\n");
  await writeFile(path.join(outDir, "index.md"), index);
  console.log(`\nWrote answers to ${path.relative(ROOT, outDir)}/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
