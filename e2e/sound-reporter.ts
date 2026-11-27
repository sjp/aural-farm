import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FullConfig, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * Collects the measurements the sound checks attach ("sound-measurements"),
 * merges them by sound, writes them to `test-results/sounds.json` and prints a
 * compact table, so a regression shows at a glance.
 */

type Row = Record<string, unknown> & { id: string };

/** The table's columns: a heading and the measurement it shows. */
const COLUMNS: readonly (readonly [string, string])[] = [
  ["LUFS", "loudness"],
  ["seeds 1–3", "levels"],
  ["peak", "worstPeakDb"],
  ["sets LUFS", "paramSetLufs"],
  ["DC", "dc"],
  ["<25 Hz", "subBassDb"],
  ["150–4k", "speakersDb"],
  ["mono", "monoLossDb"],
  ["corr", "correlation"],
  ["slope", "slope"],
  ["44.1k", "sampleRateDb"],
  ["repeat", "determinismDb"],
  ["from 10 s", "timeAddressableDb"],
  ["param click", "paramClickDb"],
  ["seed click", "seedClickDb"],
  ["seed swing", "seedSwingDb"],
  ["cost %", "costPercent"],
  ["budget", "cost"],
];

const show = (value: unknown): string => {
  if (value === undefined) {
    return "";
  }
  if (value === null) {
    // JSON has no −Infinity: renders that matched exactly.
    return "same";
  }
  if (Array.isArray(value)) {
    return value.map((v) => show(v)).join(" ");
  }
  return typeof value === "number" || typeof value === "string" ? String(value) : "?";
};

const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "id") === "string";

export default class SoundReporter implements Reporter {
  private rows = new Map<string, Row>();
  private outputDir = "test-results";

  onBegin(config: FullConfig): void {
    this.outputDir = config.projects[0]?.outputDir ?? this.outputDir;
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    for (const attachment of result.attachments) {
      if (attachment.name !== "sound-measurements" || !attachment.body) {
        continue;
      }
      const parsed: unknown = JSON.parse(attachment.body.toString("utf8"));
      if (isRow(parsed)) {
        this.rows.set(parsed.id, { ...this.rows.get(parsed.id), ...parsed });
      }
    }
  }

  onEnd(): void {
    if (this.rows.size === 0) {
      return;
    }
    const rows = Array.from(this.rows.values());
    const file = join(this.outputDir, "sounds.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);

    const columns = COLUMNS.filter(([, key]) => rows.some((row) => row[key] !== undefined));
    const table = [
      ["sound", ...columns.map(([heading]) => heading)],
      ...rows.map((row) => [row.id].concat(columns.map(([, key]) => show(row[key])))),
    ];
    const widths = table[0]?.map((_, c) =>
      Math.max(...table.map((line) => (line[c] ?? "").length)),
    );
    const lines = table.map((line) =>
      line.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join("  "),
    );
    process.stdout.write(`\nSound measurements (${file}):\n${lines.join("\n")}\n\n`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
