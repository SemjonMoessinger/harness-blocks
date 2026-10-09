/**
 * The `--key=value` flags of the harness scripts, parsed the same way for shot.ts and seed.ts.
 * A flag is `--key=value` (a string) or a bare `--key` (true); everything else is positional. An
 * unknown flag is not an error here — each script validates the flags it knows (parseSensorFlags,
 * for one). coverage-gaps.ts has a fixed option set and uses node's parseArgs strictly instead.
 */

import { parseArgs } from 'node:util';

export type Flags = Record<string, string | true>;

export function parseFlags(argv: string[]): { flags: Flags; positional: string[] } {
  const { values, positionals } = parseArgs({ args: argv, strict: false, allowPositionals: true });
  const flags: Flags = {};
  for (const [key, value] of Object.entries(values)) {
    // A flag given twice: the last one counts, as on any command line.
    const last = Array.isArray(value) ? value.at(-1) : value;
    if (last === undefined) continue;
    flags[key] = last === true ? true : String(last);
  }
  return { flags, positional: positionals };
}
