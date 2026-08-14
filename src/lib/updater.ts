import { writeFile, chmod, rename, unlink } from 'fs/promises';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import chalk from 'chalk';
import { info, success, error as logError } from './formatter.ts';
import { getAppVersion, isRunningUnderBun } from '../version.ts';

const CONFIG_DIR = join(homedir(), '.config', 'slackcli');
const UPDATE_CACHE_FILE = join(CONFIG_DIR, 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface UpdateCache {
  checkedAt: number;
  latestVersion: string;
}

const GITHUB_REPO = 'shaharia-lab/slackcli';
const CURRENT_VERSION = getAppVersion();

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

// Get current version
export function getCurrentVersion(): string {
  return CURRENT_VERSION;
}

// Fetch latest release from GitHub
export async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'SlackCLI',
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as GitHubRelease;
  } catch (error) {
    return null;
  }
}

// Compare versions (simple semver comparison)
export function isNewerVersion(latest: string, current: string): boolean {
  const latestParts = latest.replace('v', '').split('.').map(Number);
  const currentParts = current.replace('v', '').split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if (latestParts[i] > currentParts[i]) return true;
    if (latestParts[i] < currentParts[i]) return false;
  }

  return false;
}

/**
 * Hosts a release asset may legitimately download from.
 *
 * `browser_download_url` is taken from GitHub's release JSON; gating its host
 * means a tampered field (or a compromised intermediary rewriting the JSON)
 * cannot point the updater at an arbitrary origin. GitHub serves release
 * assets from github.com with a redirect to its objects CDN.
 */
const RELEASE_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export function isTrustedReleaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      RELEASE_DOWNLOAD_HOSTS.has(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

/**
 * Parse `sha256sum` output: one `<64-hex>  <filename>` pair per line
 * (a `*` before the filename marks binary mode and is equivalent).
 * Returns filename -> lowercase hex digest.
 */
export function parseChecksums(text: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match) {
      checksums.set(match[2].trim(), match[1].toLowerCase());
    }
  }
  return checksums;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Get platform-specific binary name
function getBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'linux') return arch === 'arm64' ? 'slackcli-linux-arm64' : 'slackcli-linux';
  if (platform === 'darwin') return arch === 'arm64' ? 'slackcli-macos-arm64' : 'slackcli-macos';
  if (platform === 'win32') return 'slackcli-windows.exe';

  throw new Error(`Unsupported platform: ${platform}`);
}

// Check for updates
export async function checkForUpdates(silent: boolean = true): Promise<{
  updateAvailable: boolean;
  latestVersion?: string;
  currentVersion: string;
}> {
  const release = await fetchLatestRelease();

  if (!release) {
    if (!silent) {
      info('Unable to check for updates');
    }
    return { updateAvailable: false, currentVersion: CURRENT_VERSION };
  }

  const latestVersion = release.tag_name;
  const updateAvailable = isNewerVersion(latestVersion, CURRENT_VERSION);

  if (updateAvailable && !silent) {
    info(`New version available: ${latestVersion} (current: v${CURRENT_VERSION})`);
    info('Run "slackcli update" to update');
  }

  return {
    updateAvailable,
    latestVersion,
    currentVersion: CURRENT_VERSION,
  };
}

// Download and install update
export async function performUpdate(): Promise<void> {
  if (isRunningUnderBun()) {
    info('Running from source (bun) — update with `git pull`, not `slackcli update`.');
    return;
  }

  info(`Checking for updates...`);

  const release = await fetchLatestRelease();

  if (!release) {
    throw new Error('Unable to fetch latest release');
  }

  const latestVersion = release.tag_name;

  if (!isNewerVersion(latestVersion, CURRENT_VERSION)) {
    success(`Already on latest version (v${CURRENT_VERSION})`);
    return;
  }

  info(`Downloading version ${latestVersion}...`);

  const binaryName = getBinaryName();
  const asset = release.assets.find(a => a.name === binaryName);

  if (!asset) {
    throw new Error(`Binary not found for ${binaryName}`);
  }

  // The release workflow publishes checksums.txt alongside the binaries.
  // Refusing to update without it means a release asset can never be swapped
  // in unverified — the downloaded bytes must match the digest published in
  // the same release.
  //
  // Scope, honestly: checksums.txt shares a trust root with the binary (same
  // origin, same release, same redirect chain), so this catches corruption,
  // truncation, and tampering with the binary asset alone — NOT a compromised
  // release channel or CDN, which could serve a matching pair. Closing that
  // needs a signature over checksums.txt verified against a key pinned in
  // this binary (minisign/cosign). Worth doing; deliberately not claimed here.
  const checksumAsset = release.assets.find(a => a.name === 'checksums.txt');
  if (!checksumAsset) {
    throw new Error(
      'Release has no checksums.txt — refusing to install an unverifiable binary'
    );
  }

  for (const url of [asset.browser_download_url, checksumAsset.browser_download_url]) {
    if (!isTrustedReleaseUrl(url)) {
      throw new Error(`Refusing to download a release asset from: ${url}`);
    }
  }

  const checksumResponse = await fetch(checksumAsset.browser_download_url);
  if (!checksumResponse.ok) {
    throw new Error(`Failed to download checksums: ${checksumResponse.statusText}`);
  }
  const expected = parseChecksums(await checksumResponse.text()).get(binaryName);
  if (!expected) {
    throw new Error(`checksums.txt has no entry for ${binaryName}`);
  }

  // Download binary
  const response = await fetch(asset.browser_download_url);

  if (!response.ok) {
    throw new Error(`Failed to download: ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${binaryName}: expected ${expected}, got ${actual}. ` +
      'The download may be corrupted or tampered with — not installing.'
    );
  }

  // Get current binary path
  const currentBinary = process.execPath;

  // Stage the verified binary NEXT TO the one it replaces, not in tmpdir:
  // rename() across filesystems throws EXDEV (/tmp is commonly a separate
  // mount), and a same-directory rename is atomic on POSIX.
  //
  // `wx` (O_CREAT|O_EXCL) is the security-relevant part: the staging path is
  // predictable, and a plain write follows symlinks. In a group-writable
  // install dir (/usr/local/bin, /opt) under `sudo slackcli update`, another
  // local user could pre-plant this path as a symlink and have root write
  // attacker-chosen bytes, mode 0755, wherever it points. O_EXCL fails on any
  // existing path, symlink included. The random suffix additionally makes the
  // name unguessable, so it cannot be pre-created in the first place.
  const stagingPath = `${currentBinary}.update-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(stagingPath, bytes, { mode: 0o755, flag: 'wx' });
    // writeFile's mode is masked by the umask; chmod is not, so the staged
    // binary ends up executable even under a restrictive umask.
    await chmod(stagingPath, 0o755);
  } catch (error: any) {
    // Never leave a partial ~60MB file behind on a failed write.
    await unlink(stagingPath).catch(() => {});
    logError(`Update failed: ${error.message}`);
    throw error;
  }

  info(`Installing update...`);

  const backupPath = `${currentBinary}.backup`;
  try {
    // Backup current binary
    await rename(currentBinary, backupPath);
  } catch (error: any) {
    await unlink(stagingPath).catch(() => {});
    logError(`Update failed: ${error.message}`);
    throw error;
  }

  try {
    // Move new binary to current location
    await rename(stagingPath, currentBinary);
  } catch (error: any) {
    // The old binary was already moved aside — put it back, or the user is
    // left with no slackcli at all.
    await rename(backupPath, currentBinary).catch(() => {
      logError(`Could not restore the previous binary; it is at: ${backupPath}`);
    });
    await unlink(stagingPath).catch(() => {});
    logError(`Update failed: ${error.message}`);
    throw error;
  }

  // Remove backup
  await unlink(backupPath).catch(() => {});

  success(`Updated to version ${latestVersion}`);
  info('Please restart slackcli to use the new version');
}

// Read cached update check result synchronously
function readUpdateCache(): UpdateCache | null {
  try {
    const data = readFileSync(UPDATE_CACHE_FILE, 'utf-8');
    return JSON.parse(data) as UpdateCache;
  } catch {
    return null;
  }
}

// Write update check result to cache
function writeUpdateCache(cache: UpdateCache): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    writeFileSync(UPDATE_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // Silently fail — cache is best-effort
  }
}

// Detect if the binary was installed via Homebrew
export function isInstalledViaHomebrew(): boolean {
  const execPath = process.execPath;
  return execPath.includes('homebrew') || execPath.includes('Cellar') || execPath.includes('linuxbrew');
}

// Return the appropriate update command for this installation
export function getUpdateCommand(): string {
  return isInstalledViaHomebrew() ? 'brew upgrade slackcli' : 'slackcli update';
}

// Show a one-line update notification after the command finishes (via beforeExit),
// and refresh the cache in the background if it is stale.
export function notifyIfUpdateAvailable(): void {
  // Local `bun run` / source checkout — not a release binary; skip self-update nags.
  if (isRunningUnderBun()) {
    return;
  }

  const cache = readUpdateCache();
  const now = Date.now();

  // Trigger a background cache refresh if missing or older than 24h
  if (!cache || (now - cache.checkedAt) > CHECK_INTERVAL_MS) {
    fetchLatestRelease()
      .then(release => {
        if (release) {
          writeUpdateCache({ checkedAt: now, latestVersion: release.tag_name });
        }
      })
      .catch(() => {});
  }

  // Nothing to show if cache is empty or already on latest
  if (!cache || !isNewerVersion(cache.latestVersion, CURRENT_VERSION)) {
    return;
  }

  const updateCmd = getUpdateCommand();
  let printed = false;

  process.on('beforeExit', () => {
    if (printed) return;
    printed = true;
    process.stderr.write(
      chalk.yellow(`\n  Update available: v${CURRENT_VERSION} → ${cache.latestVersion}\n`) +
      chalk.dim(`  Run: ${updateCmd}\n`),
    );
  });
}
