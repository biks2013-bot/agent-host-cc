// Startup banner: prints the bound URL/port and the full list of environment
// variables the service reads, with secret-like values masked. Designed to be
// the first user-visible line of output after `app.listen()` succeeds, so an
// operator running the service locally or in a container can confirm at a
// glance which configuration is active.
//
// Masking policy:
//   - Variables flagged `secret: true` are masked unless `reveal: true` overrides
//     it. AGENT_HOST_API_KEY is intentionally revealed: the operator typically
//     copies it from the log to authenticate the first client request, and the
//     value is already required to be present in client `Authorization` headers
//     for every call — masking it would create friction without adding privacy
//     guarantees beyond what the deployment's log-access controls already give.
//   - Every other API key / token in the list is shown as `xxxx…yyyy (len=N)`
//     so an operator can verify "the right key is loaded" without the value
//     itself leaking to a screenshot or copy-paste of the log.

interface EnvVarSpec {
  name: string;
  category: string;
  required: boolean;
  secret: boolean;
  /** Show the value in full even when secret. Reserved for AGENT_HOST_API_KEY. */
  reveal?: boolean;
}

const ENV_VAR_SPECS: EnvVarSpec[] = [
  // HTTP surface
  { name: "AGENT_HOST_API_KEY",             category: "HTTP",       required: true,  secret: true, reveal: true },
  { name: "AGENT_HOST_API_KEY_EXPIRES_AT",  category: "HTTP",       required: false, secret: false },
  { name: "LISTEN_PORT",                    category: "HTTP",       required: false, secret: false },
  { name: "LOG_LEVEL",                      category: "HTTP",       required: false, secret: false },
  { name: "MODEL_IDS",                      category: "HTTP",       required: true,  secret: false },
  { name: "MODEL_PREFIX",                   category: "HTTP",       required: false, secret: false },
  { name: "RESPONSES_TOOL_USE_RENDERING",   category: "HTTP",       required: false, secret: false },

  // Upstream provider
  { name: "CLAUDE_CODE_USE_FOUNDRY",           category: "Provider", required: false, secret: false },
  { name: "ANTHROPIC_API_KEY",                 category: "Provider", required: false, secret: true  },
  { name: "ANTHROPIC_API_KEY_EXPIRES_AT",      category: "Provider", required: false, secret: false },
  { name: "ANTHROPIC_FOUNDRY_API_KEY",         category: "Provider", required: false, secret: true  },
  { name: "ANTHROPIC_FOUNDRY_RESOURCE",        category: "Provider", required: false, secret: false },
  { name: "ANTHROPIC_FOUNDRY_API_KEY_EXPIRES_AT", category: "Provider", required: false, secret: false },

  // Files API
  { name: "FILES_API_BASE_URL",        category: "Files API", required: false, secret: false },
  { name: "FILES_API_KEY",             category: "Files API", required: false, secret: true  },
  { name: "FILES_API_KEY_EXPIRES_AT",  category: "Files API", required: false, secret: false },
  { name: "FILES_API_PATH_TEMPLATE",   category: "Files API", required: false, secret: false },

  // Workspace
  { name: "WORKSPACE_DIR",                 category: "Workspace", required: false, secret: false },
  { name: "WORKSPACE_MAX_BYTES_PER_CHAT",  category: "Workspace", required: false, secret: false },

  // Behavioural limits
  { name: "MAX_URL_FETCHES_PER_TURN", category: "Limits", required: false, secret: false },
  { name: "MAX_REMOTE_FETCH_BYTES",   category: "Limits", required: false, secret: false },
  { name: "URL_FETCH_TIMEOUT_MS",     category: "Limits", required: false, secret: false },
  { name: "AGENT_TIMEOUT_MS",         category: "Limits", required: false, secret: false },
  { name: "AGENT_MAX_TURNS",          category: "Limits", required: false, secret: false },
];

// Mask a secret value while keeping enough fingerprint information for an
// operator to verify which key is loaded. Very short values (<8 chars) are
// fully masked because the first-4/last-4 reveal would expose the whole
// string.
const maskSecret = (v: string): string => {
  if (v.length < 8) return `<set, len=${v.length}>`;
  return `${v.slice(0, 4)}…${v.slice(-4)} (len=${v.length})`;
};

export interface BannerInput {
  listenHost: string;
  listenPort: number;
  modelIds: string[];
  providerKind: string;
}

export const renderStartupBanner = (
  input: BannerInput,
  env: Record<string, string | undefined> = process.env,
): string => {
  const bar = "═".repeat(78);
  const sub = "─".repeat(78);
  const lines: string[] = [];

  lines.push(bar);
  lines.push(" agent-host-cc — ready");
  lines.push(sub);
  // Listen address — print both the bind address (what's actually open on the
  // network) and the localhost convenience URL so a local operator can click
  // through without translating 0.0.0.0.
  lines.push(` Listening on:   http://${input.listenHost}:${input.listenPort}`);
  if (input.listenHost === "0.0.0.0" || input.listenHost === "::") {
    lines.push(` Local URL:      http://localhost:${input.listenPort}`);
  }
  lines.push(` Provider kind:  ${input.providerKind}`);
  lines.push(` Models:         ${input.modelIds.join(", ")}`);
  lines.push(sub);
  lines.push(" Environment variables (secrets masked; AGENT_HOST_API_KEY revealed)");

  // Group entries by category preserving spec order, so the banner reads in
  // the same order operators see in .env.example and the configuration guide.
  const grouped: Record<string, EnvVarSpec[]> = {};
  const order: string[] = [];
  for (const spec of ENV_VAR_SPECS) {
    if (!(spec.category in grouped)) {
      grouped[spec.category] = [];
      order.push(spec.category);
    }
    grouped[spec.category]!.push(spec);
  }

  const namePad = ENV_VAR_SPECS.reduce((m, s) => Math.max(m, s.name.length), 0);
  for (const cat of order) {
    lines.push(` [${cat}]`);
    for (const spec of grouped[cat]!) {
      const raw = env[spec.name];
      let display: string;
      if (raw === undefined || raw === "") {
        display = spec.required ? "<UNSET — REQUIRED>" : "<unset>";
      } else if (spec.secret && !spec.reveal) {
        display = maskSecret(raw);
      } else {
        display = raw;
      }
      lines.push(`   ${spec.name.padEnd(namePad)} = ${display}`);
    }
  }
  lines.push(bar);
  return lines.join("\n");
};

export const printStartupBanner = (
  input: BannerInput,
  env: Record<string, string | undefined> = process.env,
): void => {
  // console.info bypasses Pino's structured JSON formatter so the banner is
  // readable even when LOG_LEVEL=info emits one JSON object per agent event.
  // The banner is one-shot at startup, so the slight protocol break is fine.
  console.info(renderStartupBanner(input, env));
};
