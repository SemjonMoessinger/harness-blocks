import type { ShotConfig } from './shot-sensors.ts';

/**
 * The sensor settings of the screenshot harness — the human's half. The agent's flags (`--checks`,
 * `--skip`, `--detail`) can narrow what runs, never widen it: a sensor set to `false` here stays off.
 * Every field and its default is documented on the interfaces in shot-sensors.ts.
 *
 * ADAPT: decide which sensors run by default for this app and what they ignore — a clock to mask for the diff, a third-party iframe to exclude from axe, a sensor to switch off for good.
 */
const config: ShotConfig = {
  checks: {},
};

export default config;
