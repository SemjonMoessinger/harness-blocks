import type { ShotConfig } from '../shot-sensors.ts';

/** raw.html's markup is only broken before the browser repairs it, so only the raw source can see it. */
const config: ShotConfig = {
  checks: { html: { raw: true } },
};

export default config;
