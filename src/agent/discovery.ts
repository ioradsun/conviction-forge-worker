/**
 * Discovery — the office-hours planning session, before any job exists.
 *
 * A human (the business) says what they want in a line; the AI (the CTO) reads
 * the actual codebase once, then interrogates them — one sharp question at a
 * time — until there is a brief an engineer can build without guessing. This
 * module is the worker's half: it produces the one-time repo digest and each
 * AI turn. The conversation and the evolving plan are stored by the app; the
 * worker holds no session state.
 *
 * The turn is a plain OpenRouter call wearing gstack's office-hours persona —
 * fast and cheap, so the conversation feels like a conversation. It is grounded
 * by the digest, not by re-reading the repo every message.
 */
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_DISCOVERY_PLAN,
  type DiscoveryMessage,
  type DiscoveryPlan,
  type DiscoveryTurnResult,
  type RepoDigest,
} from "../contract.ts";
import { shallowCloneBase } from "../git/repo.ts";
import { run } from "../shell.ts";
import { callModel, extractJson, type ChatMessage } from "./openrouter.ts";

/* ── The repo digest — the one code read ──────────────────────────────────── */

const MAX_TREE = 260;
const MAX_FILES = 6;
const MAX_EXCERPT = 2600;
/** The repo map (AGENTS.md) gets more room — it grounds every session. */
const MAX_MAP_EXCERPT = 6000;
/** Always read, whatever the request: the repo's own map for coding agents. */
const MAP_FILES = ["AGENTS.md", "README.md"];

/** Words too generic to steer file relevance in a product that is all about users. */
const STOP = new Set([
  "that", "this", "with", "from", "have", "want", "should", "would", "when", "what",
  "make", "need", "them", "they", "into", "your", "about", "just", "like", "some",
  "there", "where", "which", "their", "been", "will", "then", "than", "user", "users",
]);

function keywords(request: string): string[] {
  const raw = request.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  return Array.from(new Set(raw)).filter((t) => !STOP.has(t));
}

/** Rank source paths by how well they match the request. Basename hits weigh most. */
function rankByRelevance(paths: string[], request: string): string[] {
  const kw = keywords(request);
  if (kw.length === 0) return [];
  const score = (p: string) => {
    const lower = p.toLowerCase();
    const base = lower.split("/").pop() ?? lower;
    let s = 0;
    for (const t of kw) {
      if (base.includes(t)) s += 2;
      else if (lower.includes(t)) s += 1;
    }
    return s;
  };
  return paths
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.p);
}

/**
 * Clone belief-compass shallowly, once, and read out a digest: a partial source
 * tree plus the files most relevant to the request. The checkout is removed
 * before returning — this is a read, not a workspace.
 */
export async function buildRepoDigest(request: string): Promise<RepoDigest> {
  const dir = join(tmpdir(), `cfw-discovery-${crypto.randomUUID()}`);
  try {
    await shallowCloneBase(dir);
    const listed = await run(["git", "ls-files"], { cwd: dir, timeoutMs: 30_000 });
    const all = listed.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    const src = all.filter(
      (p) => /^src\//.test(p) && /\.(ts|tsx|sql)$/.test(p) && !/\.(test|spec)\./.test(p),
    );

    // The repo's own map (AGENTS.md) grounds the CTO every session — so it
    // knows the app's layers and conventions — alongside the files the request
    // points at. The map goes first.
    const files: { path: string; excerpt: string }[] = [];
    for (const p of MAP_FILES) {
      try {
        const content = await readFile(join(dir, p), "utf8");
        files.push({ path: p, excerpt: content.slice(0, MAX_MAP_EXCERPT) });
      } catch {
        /* not present — fine */
      }
    }

    const ranked = rankByRelevance(src, request).slice(0, MAX_FILES);
    for (const p of ranked) {
      try {
        const content = await readFile(join(dir, p), "utf8");
        files.push({ path: p, excerpt: content.slice(0, MAX_EXCERPT) });
      } catch {
        /* unreadable file — skip it rather than fail the digest */
      }
    }

    return { tree: src.slice(0, MAX_TREE).join("\n"), files, relevantPaths: ranked };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ── The CTO ──────────────────────────────────────────────────────────────── */

const CTO_PROMPT = `You are the CTO of Conviction, in an office-hours planning session with the business (the user). They tell you what they want; you turn it into a plan an engineer can build WITHOUT guessing. Conviction is a belief-market product: challenge → match → resolve → reputation → repeat.

You are given a DIGEST of the ACTUAL codebase. Ground everything in it — reference real files and mechanisms, and never invent an API. Do not ask the business anything the code already answers; read it instead.

Your method, every single turn:
- Ask EXACTLY ONE question — the one that most reduces ambiguity or surfaces an edge case the business has not considered (declines, expiry, empty states, permissions, visibility, concurrency, abuse, what happens to data that already exists). One good question beats five.
- Prefer to offer 2–4 short suggested answers the business can pick from, and put the one you would recommend first.
- You are the expert on feasibility and edge cases; the business is the expert on intent. Push back when something is under-specified or risky; defer to them on what the product should do.
- Keep a running, structured plan and move at least one field forward every turn.
- When the plan is buildable — intent is clear, the major edge cases are decided, and the acceptance criteria are concrete and testable — set "ready" to true, STOP asking questions, and tell them it is ready to hand to the pipeline.

Respond with STRICT JSON ONLY — no prose outside it — in exactly this shape:
{
  "message": "<your next message to the business; concise, may use markdown>",
  "suggestedAnswers": ["<a short answer they could click>"],
  "plan": {
    "title": "<= 8 words",
    "problem": "<the real problem, in the business's terms>",
    "behavior": "<the desired behaviour, concretely>",
    "edgeCases": ["<a decided edge case and its resolution>"],
    "constraints": ["<what to reuse or not touch, drawn from the code>"],
    "acceptanceCriteria": ["<a testable statement of done>"],
    "relevantFiles": ["<a real path from the digest this will touch>"],
    "openQuestions": ["<what is still undecided>"]
  },
  "ready": false
}
Fill every field you can from the conversation so far; use [] for what is not yet known. "ready" is true only when "openQuestions" holds nothing blocking.`;

function renderDigest(digest: RepoDigest): string {
  const files = digest.files
    .map((f) => `--- ${f.path} ---\n${f.excerpt}`)
    .join("\n\n");
  return [
    "REPOSITORY DIGEST — belief-compass (read once for this session).",
    digest.files.length
      ? `Files most relevant to the request:\n\n${files}`
      : "No file matched the request by name; rely on the tree below.",
    `\nPartial source tree:\n${digest.tree}`,
  ].join("\n\n");
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function normalizePlan(v: unknown): DiscoveryPlan {
  if (!v || typeof v !== "object") return { ...EMPTY_DISCOVERY_PLAN };
  const p = v as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  return {
    title: str("title"),
    problem: str("problem"),
    behavior: str("behavior"),
    edgeCases: asStringArray(p.edgeCases),
    constraints: asStringArray(p.constraints),
    acceptanceCriteria: asStringArray(p.acceptanceCriteria),
    relevantFiles: asStringArray(p.relevantFiles),
    openQuestions: asStringArray(p.openQuestions),
  };
}

/** Coerce a model reply into the turn shape; never throw on imperfect JSON. */
function normalizeTurn(parsed: unknown, raw: string): DiscoveryTurnResult {
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const message =
    typeof obj.message === "string" && obj.message.trim()
      ? obj.message
      : raw.trim() || "Tell me more about what you're trying to do.";
  return {
    message,
    suggestedAnswers: asStringArray(obj.suggestedAnswers).slice(0, 4),
    plan: normalizePlan(obj.plan),
    ready: obj.ready === true,
  };
}

/**
 * One turn of the conversation. The digest and the whole message history are
 * passed in by the app; nothing is stored here.
 */
export async function discoveryTurn(opts: {
  model: string;
  request: string;
  digest: RepoDigest;
  messages: DiscoveryMessage[];
}): Promise<DiscoveryTurnResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: CTO_PROMPT },
    { role: "system", content: renderDigest(opts.digest) },
    { role: "user", content: `The business's initial request:\n${opts.request}` },
    ...opts.messages.map(
      (m): ChatMessage => ({
        role: m.role === "ai" ? "assistant" : "user",
        content: m.content,
      }),
    ),
  ];

  const res = await callModel(opts.model, messages, {
    timeoutMs: 90_000,
    maxTokens: 1600,
    temperature: 0.4,
  });
  return normalizeTurn(extractJson(res.text), res.text);
}
