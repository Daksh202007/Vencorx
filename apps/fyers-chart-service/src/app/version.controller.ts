import { Controller, Get } from '@nestjs/common';
import { execSync } from 'child_process';

/**
 * Try to get a value from:
 *  1. Process env (set at Docker build time via ARG/ENV — most reliable in containers)
 *  2. execSync git command (works locally or if .git is present in the container)
 *  3. Fallback string
 */
function resolve(envKey: string, gitCmd: string, fallback = 'unknown'): string {
  // Level 1: baked-in env var (Docker build arg)
  const fromEnv = process.env[envKey];
  if (fromEnv && fromEnv !== 'unknown' && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }

  // Level 2: live git command (local dev / CI without build args)
  try {
    return execSync(gitCmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return fallback;
  }
}

// Resolved once at module load — zero overhead on every HTTP request
const VERSION_INFO = {
  commit:      resolve('GIT_COMMIT',  'git rev-parse HEAD'),
  shortCommit: resolve('GIT_COMMIT',  'git rev-parse --short HEAD', 'unknown').slice(0, 7),
  branch:      resolve('GIT_BRANCH',  'git rev-parse --abbrev-ref HEAD'),
  tag:         resolve('GIT_TAG',     'git describe --tags --always --dirty', 'no-tag'),
  buildTime:   process.env.BUILD_TIME || new Date().toISOString(),
};

@Controller('version')
export class VersionController {
  @Get()
  getVersion() {
    return VERSION_INFO;
  }
}
