import { afterEach, describe, expect, it } from 'bun:test';
import {
  isNewerVersion,
  isInstalledViaHomebrew,
  getUpdateCommand,
  getCurrentVersion,
  performUpdate,
  parseChecksums,
  isTrustedReleaseUrl,
  sha256Hex,
} from './updater.ts';
import packageJson from '../../package.json';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('isNewerVersion', () => {
  it('returns true when latest is newer', () => {
    expect(isNewerVersion('v0.5.0', '0.4.0')).toBe(true);
  });

  it('returns false when already on latest', () => {
    expect(isNewerVersion('v0.4.0', '0.4.0')).toBe(false);
  });

  it('returns false when current is newer', () => {
    expect(isNewerVersion('v0.3.0', '0.4.0')).toBe(false);
  });

  it('handles patch version bumps', () => {
    expect(isNewerVersion('v0.4.1', '0.4.0')).toBe(true);
    expect(isNewerVersion('v0.4.0', '0.4.1')).toBe(false);
  });

  it('handles major version bumps', () => {
    expect(isNewerVersion('v1.0.0', '0.9.9')).toBe(true);
  });
});

describe('isInstalledViaHomebrew', () => {
  const originalExecPath = process.execPath;

  it('detects macOS Homebrew Cellar path', () => {
    Object.defineProperty(process, 'execPath', { value: '/usr/local/Cellar/slackcli/0.4.0/bin/slackcli', configurable: true });
    expect(isInstalledViaHomebrew()).toBe(true);
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it('detects macOS Apple Silicon Homebrew path', () => {
    Object.defineProperty(process, 'execPath', { value: '/opt/homebrew/bin/slackcli', configurable: true });
    expect(isInstalledViaHomebrew()).toBe(true);
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it('detects Linux Homebrew path', () => {
    Object.defineProperty(process, 'execPath', { value: '/home/linuxbrew/.linuxbrew/bin/slackcli', configurable: true });
    expect(isInstalledViaHomebrew()).toBe(true);
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it('returns false for direct binary install', () => {
    Object.defineProperty(process, 'execPath', { value: '/usr/local/bin/slackcli', configurable: true });
    expect(isInstalledViaHomebrew()).toBe(false);
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it('returns false for path in home directory', () => {
    Object.defineProperty(process, 'execPath', { value: '/home/user/bin/slackcli', configurable: true });
    expect(isInstalledViaHomebrew()).toBe(false);
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });
});

describe('getUpdateCommand', () => {
  const originalExecPath = process.execPath;

  it('returns brew command for Homebrew installs', () => {
    Object.defineProperty(process, 'execPath', { value: '/opt/homebrew/bin/slackcli', configurable: true });
    expect(getUpdateCommand()).toBe('brew upgrade slackcli');
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });

  it('returns slackcli update for direct installs', () => {
    Object.defineProperty(process, 'execPath', { value: '/usr/local/bin/slackcli', configurable: true });
    expect(getUpdateCommand()).toBe('slackcli update');
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  });
});

describe('getCurrentVersion', () => {
  it('matches package.json when not running a baked-in binary', () => {
    expect(getCurrentVersion()).toBe(packageJson.version);
  });
});

describe('parseChecksums', () => {
  it('parses sha256sum output', () => {
    const hexA = 'a'.repeat(64);
    const hexB = 'B'.repeat(64);
    const parsed = parseChecksums(
      `${hexA}  slackcli-linux\n${hexB} *slackcli-macos\n\nnot a checksum line\n`
    );
    expect(parsed.get('slackcli-linux')).toBe(hexA);
    expect(parsed.get('slackcli-macos')).toBe('b'.repeat(64)); // lowercased
    expect(parsed.size).toBe(2);
  });

  it('ignores lines with a malformed digest', () => {
    expect(parseChecksums(`${'a'.repeat(63)}  short-digest\n`).size).toBe(0);
    expect(parseChecksums(`${'z'.repeat(64)}  non-hex\n`).size).toBe(0);
  });
});

describe('isTrustedReleaseUrl', () => {
  it('accepts https GitHub release hosts', () => {
    expect(isTrustedReleaseUrl('https://github.com/o/r/releases/download/v1/x')).toBe(true);
    expect(isTrustedReleaseUrl('https://objects.githubusercontent.com/x')).toBe(true);
  });

  it('rejects other hosts, http, and lookalikes', () => {
    expect(isTrustedReleaseUrl('https://evil.example/x')).toBe(false);
    expect(isTrustedReleaseUrl('http://github.com/x')).toBe(false);
    expect(isTrustedReleaseUrl('https://github.com.evil.net/x')).toBe(false);
    expect(isTrustedReleaseUrl('not a url')).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('computes the SHA-256 of the input bytes', () => {
    // Known digest of the ASCII string "abc".
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

describe('performUpdate', () => {
  const originalExecPath = process.execPath;

  const withExecPath = async (value: string, run: () => Promise<void>): Promise<void> => {
    Object.defineProperty(process, 'execPath', { value, configurable: true });
    try {
      await run();
    } finally {
      Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    }
  };

  const releaseJson = (assets: Array<{ name: string; browser_download_url: string }>) => ({
    tag_name: 'v99.0.0',
    name: 'v99.0.0',
    body: '',
    assets,
  });

  it('bails early when running under bun without downloading', async () => {
    await withExecPath('/Users/me/.bun/bin/bun', async () => {
      await expect(performUpdate()).resolves.toBeUndefined();
    });
  });

  it('refuses a release that publishes no checksums.txt', async () => {
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        return Response.json(
          releaseJson([
            { name: 'slackcli-macos', browser_download_url: 'https://github.com/o/r/releases/download/v99.0.0/slackcli-macos' },
            { name: 'slackcli-macos-arm64', browser_download_url: 'https://github.com/o/r/releases/download/v99.0.0/slackcli-macos-arm64' },
            { name: 'slackcli-linux', browser_download_url: 'https://github.com/o/r/releases/download/v99.0.0/slackcli-linux' },
            { name: 'slackcli-linux-arm64', browser_download_url: 'https://github.com/o/r/releases/download/v99.0.0/slackcli-linux-arm64' },
            { name: 'slackcli-windows.exe', browser_download_url: 'https://github.com/o/r/releases/download/v99.0.0/slackcli-windows.exe' },
          ])
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await withExecPath('/usr/local/bin/slackcli', async () => {
      await expect(performUpdate()).rejects.toThrow('no checksums.txt');
    });
  });

  it('refuses a binary asset hosted off GitHub', async () => {
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        return Response.json(
          releaseJson([
            { name: 'slackcli-macos', browser_download_url: 'https://evil.example/slackcli-macos' },
            { name: 'slackcli-macos-arm64', browser_download_url: 'https://evil.example/slackcli-macos-arm64' },
            { name: 'slackcli-linux', browser_download_url: 'https://evil.example/slackcli-linux' },
            { name: 'slackcli-linux-arm64', browser_download_url: 'https://evil.example/slackcli-linux-arm64' },
            { name: 'slackcli-windows.exe', browser_download_url: 'https://evil.example/slackcli-windows.exe' },
            { name: 'checksums.txt', browser_download_url: 'https://github.com/o/r/releases/download/v99.0.0/checksums.txt' },
          ])
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await withExecPath('/usr/local/bin/slackcli', async () => {
      await expect(performUpdate()).rejects.toThrow('Refusing to download a release asset from');
    });
  });

  it('rejects a binary whose digest does not match checksums.txt, before installing', async () => {
    const binaryBytes = new TextEncoder().encode('malicious payload');
    const wrongDigest = 'a'.repeat(64);
    const assetUrl = (name: string) =>
      `https://github.com/o/r/releases/download/v99.0.0/${name}`;
    const names = ['slackcli-macos', 'slackcli-macos-arm64', 'slackcli-linux', 'slackcli-linux-arm64', 'slackcli-windows.exe'];

    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        return Response.json(
          releaseJson([
            ...names.map(name => ({ name, browser_download_url: assetUrl(name) })),
            { name: 'checksums.txt', browser_download_url: assetUrl('checksums.txt') },
          ])
        );
      }
      if (url.endsWith('/checksums.txt')) {
        return new Response(names.map(name => `${wrongDigest}  ${name}`).join('\n'));
      }
      return new Response(binaryBytes);
    }) as typeof fetch;

    await withExecPath('/usr/local/bin/slackcli', async () => {
      await expect(performUpdate()).rejects.toThrow('Checksum mismatch');
    });
  });
});
