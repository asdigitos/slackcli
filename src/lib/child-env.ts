/**
 * Environment for spawned helper processes.
 *
 * Children inherit `process.env` by default. Once a user exports
 * SLACKCLI_TOKEN / SLACKCLI_XOXD / SLACKCLI_XOXC — the natural way to use the
 * env-var login, since retyping them per command is what pushes people back to
 * the argv flags — that live Slack credential would otherwise be handed to
 * every helper this CLI spawns: pbpaste, xclip/xsel, PowerShell, and the
 * browser launched by `login-auto`. None of them need it, and the browser in
 * particular exposes its environment to extensions and crash reporters.
 */
const SECRET_ENV_VARS = ['SLACKCLI_TOKEN', 'SLACKCLI_XOXD', 'SLACKCLI_XOXC'];

export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Matched case-insensitively, not by `delete env.SLACKCLI_TOKEN`. Windows
  // environment variables are case-insensitive and `process.env` honours that
  // on read — so `set slackcli_token=…` authenticates fine — but spreading
  // into a plain object loses it, and an exact-case delete would then miss the
  // very key that just worked.
  for (const key of Object.keys(env)) {
    if (SECRET_ENV_VARS.includes(key.toUpperCase())) delete env[key];
  }
  return env;
}
