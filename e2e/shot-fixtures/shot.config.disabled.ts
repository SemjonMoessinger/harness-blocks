import type { ShotConfig } from '../shot-sensors.ts';

/** Proves that `--checks` cannot switch on what the config switched off. */
const config: ShotConfig = {
  checks: { cls: false },
};

export default config;
