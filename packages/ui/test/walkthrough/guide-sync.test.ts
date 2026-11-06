/**
 * Keeps the maintained docs in step with the walkthrough (vtt-nb8.12;
 * CLAUDE.md Conventions: README.md and docs/FIRST-SESSION.md are maintained
 * docs; M6 plan Q14 and orchestrator note 7).
 *
 * docs/FIRST-SESSION.md: one `### Step N — <title>` heading per entry of
 * `WALKTHROUGH_STEPS`, in order; each step quotes its DESIGN.md §8.4 text,
 * carries one blank `Result:` line, and names the positions and typed values
 * the scripted walkthrough uses (prep.ts, play-a.ts, play-b.ts); steps 10 and
 * 14 give the Discard recovery for a miss; the file ends with `Felt good:`.
 *
 * README.md: the quick-start and agent commands, and a keys and gestures
 * table holding every `KEY_BINDINGS` and `HELP_GESTURES` entry as a row.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CRYPT_MAP } from "@vtt/fixtures";
import { HELP_GESTURES, KEY_BINDINGS } from "@vtt/ui";
import { describe, expect, test } from "vitest";
import type { Point } from "./contract";
import {
  ALDRIC_BACK,
  ALDRIC_BINDER_AT,
  ALDRIC_IN_ROOM2,
  ROOM1_SPOTS,
  STRIP_RECT,
  STRIP_SLOTS,
  TRAY_DROPS,
  TRAY_FORMULA,
  TRAY_RECT,
} from "./play-a";
import {
  BRENNA_IN_ROOM3,
  FIREBALL_AT,
  NOTE_AT,
  NOTE_TEXT,
  TRAP_DIE_AT,
  ZONE_DROP,
  ZONE_NUDGE,
} from "./play-b";
import { CHARACTERS, GOBLIN_DROPS, HIT_FORMULA, REHIDE_FORMULA } from "./prep";
import { WALKTHROUGH_STEPS } from "./steps";

const ROOT = resolve(import.meta.dirname, "../../../..");
const read = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

const GUIDE = read("docs/FIRST-SESSION.md");
const README = read("README.md");
const DESIGN = read("docs/DESIGN.md");

const RESULT_LINE = "Result: ok / friction / broken — game went differently: yes / no — notes:";
const FELT_GOOD = "Felt good: yes / not yet — why:";
const HEADING = /^### Step (\d+) — (.+)$/;

/** Collapses runs of whitespace, so wrapped text compares equal to unwrapped. */
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The guide's step sections: number, title and body lines (up to the next `##`/`###`). */
function guideSteps(): { n: number; title: string; lines: string[] }[] {
  const out: { n: number; title: string; lines: string[] }[] = [];
  let cur: { n: number; title: string; lines: string[] } | null = null;
  for (const line of GUIDE.split("\n")) {
    const m = HEADING.exec(line);
    if (m !== null) {
      cur = { n: Number(m[1]), title: m[2] as string, lines: [] };
      out.push(cur);
    } else if (/^#{1,3} /.test(line)) {
      cur = null;
    } else if (cur !== null) {
      cur.lines.push(line);
    }
  }
  return out;
}

/** The numbered steps of DESIGN.md §8.4, each joined onto one line. */
function designSteps(): Map<number, string> {
  const start = DESIGN.indexOf("### 8.4 ");
  const end = DESIGN.indexOf("\n## 9. ", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const steps = new Map<number, string>();
  let cur: number | null = null;
  for (const line of DESIGN.slice(start, end).split("\n")) {
    const m = /^(\d+)\. (.*)$/.exec(line);
    if (m !== null) {
      cur = Number(m[1]);
      steps.set(cur, m[2] as string);
    } else if (cur !== null && line.startsWith("   ")) {
      steps.set(cur, `${steps.get(cur)} ${line.trim()}`);
    } else {
      cur = null;
    }
  }
  return steps;
}

const pt = (p: Point): string => `[${p[0]}, ${p[1]}]`;
const m = (p: Point): string => `M + ${pt(p)}`;

/** What each step's text must name, by step number: the walkthrough's own constants. */
const STEP_NAMES: Record<number, string[]> = {
  2: [
    HIT_FORMULA,
    ...CHARACTERS.map((c) => pt(c.at)),
    ...CHARACTERS.map(
      (c) => `| ${c.name} | ${c.ac} | ${c.max_hp} | ${c.attack_bonus} | ${c.dex_save} |`,
    ),
  ],
  3: [
    REHIDE_FORMULA,
    ...CRYPT_MAP.rooms.map((r) => {
      const [x, y, w, h] = r.rect_px.map((v) => v / CRYPT_MAP.px_per_unit) as number[];
      return `| ${r.n} | ${r.name} | ${m([x as number, y as number])} | ${w} × ${h} |`;
    }),
  ],
  4: [HIT_FORMULA, ...GOBLIN_DROPS.map(m)],
  8: [...Object.values(ROOM1_SPOTS).map(m), m(ALDRIC_IN_ROOM2), m(ALDRIC_BACK)],
  9: [
    TRAY_FORMULA,
    ...TRAY_RECT.map(m),
    ...TRAY_DROPS.map(m),
    ...STRIP_RECT.map(m),
    ...STRIP_SLOTS.map(m),
  ],
  10: [m(ALDRIC_BINDER_AT)],
  12: [m(BRENNA_IN_ROOM3), m(FIREBALL_AT), m(ZONE_DROP), m(ZONE_NUDGE)],
  13: [m(NOTE_AT), NOTE_TEXT, m(TRAP_DIE_AT)],
};

describe("docs/FIRST-SESSION.md", () => {
  test("has one `### Step N — <title>` heading per WALKTHROUGH_STEPS entry, in order", () => {
    const headings = GUIDE.split("\n").filter((l) => l.startsWith("### Step"));
    for (const h of headings) expect(h).toMatch(HEADING);
    expect(guideSteps().map((s) => ({ n: s.n, title: s.title }))).toEqual(
      WALKTHROUGH_STEPS.map((s, i) => ({ n: i + 1, title: s.title })),
    );
  });

  test("each step has exactly one blank Result line", () => {
    for (const s of guideSteps()) {
      const results = s.lines.filter((l) => l.trim().startsWith("Result:"));
      expect(results, `step ${s.n}`).toEqual([RESULT_LINE]);
    }
  });

  test("each step quotes its DESIGN.md §8.4 text", () => {
    const design = designSteps();
    expect([...design.keys()]).toEqual(WALKTHROUGH_STEPS.map((_, i) => i + 1));
    for (const s of guideSteps()) {
      const quoted = squash(
        s.lines
          .filter((l) => l.startsWith(">"))
          .map((l) => l.replace(/^>\s?/, ""))
          .join(" "),
      );
      expect(quoted, `step ${s.n}`).toContain(squash(design.get(s.n) as string));
    }
  });

  test("each step names the walkthrough's positions and typed values", () => {
    const steps = guideSteps();
    for (const [n, names] of Object.entries(STEP_NAMES)) {
      const body = steps.find((s) => s.n === Number(n))?.lines.join("\n") ?? "";
      for (const name of names) expect(body, `step ${n}`).toContain(name);
    }
  });

  test("steps 10 and 14 give the Discard recovery for a miss", () => {
    for (const n of [10, 14]) {
      const body = guideSteps()
        .find((s) => s.n === n)
        ?.lines.join("\n");
      expect(body, `step ${n}`).toContain("Discard");
    }
  });

  test("step 15 reopens the table with --no-open", () => {
    const body = guideSteps()
      .find((s) => s.n === 15)
      ?.lines.join("\n");
    expect(body).toContain("--no-open");
  });

  test("ends with the Felt good line", () => {
    const lines = GUIDE.trimEnd().split("\n");
    expect(lines.at(-1)).toBe(FELT_GOOD);
  });
});

describe("README.md", () => {
  test("has the quick start and the agent hookup", () => {
    expect(README).toContain("pnpm start tables/crypt.table.json");
    expect(README).toContain("--no-build");
    expect(README).toContain("pnpm start tables/crypt.table.json --no-open");
    expect(README).toContain("pnpm --silent --dir");
    expect(README).toContain("claude mcp add vtt -- pnpm --silent --dir");
    expect(README).toContain('{"command": "pnpm", "args": ["--silent", "--dir", "<repo>", "mcp"]}');
  });

  test("lists every KEY_BINDINGS entry as a table row", () => {
    for (const b of KEY_BINDINGS) expect(README).toContain(`| \`${b.keys}\` | ${b.label} |`);
  });

  test("lists every HELP_GESTURES entry as a table row", () => {
    for (const g of HELP_GESTURES) expect(README).toContain(`| ${g.gesture} | ${g.effect} |`);
  });

  test("links the docs", () => {
    for (const doc of ["DESIGN", "FORMULAS", "PROTOCOL", "FIXTURES", "FIRST-SESSION"]) {
      expect(README).toContain(`(docs/${doc}.md)`);
    }
  });
});
