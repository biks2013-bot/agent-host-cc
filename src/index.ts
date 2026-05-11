import { loadConfig } from "./config.js";
import { buildApp } from "./httpServer.js";
import { createWorkspaceManager } from "./workspaceManager.js";
import { createAttachmentProcessor } from "./attachmentProcessor.js";
import { createClaudeCodeRunner } from "./claudeCodeRunner.js";
import { printStartupBanner } from "./startupBanner.js";

const main = async () => {
  const cfg = loadConfig();

  // expiry warnings
  const warnIfNear = (label: string, iso: string | undefined) => {
    if (!iso) return;
    const d = new Date(iso); const days = (d.getTime() - Date.now()) / 86_400_000;
    if (days < 0) console.error(`[expiry] ${label} EXPIRED on ${iso}`);
    else if (days <= 30) console.warn(`[expiry] ${label} expires in ${Math.ceil(days)} days (${iso})`);
  };
  warnIfNear("AGENT_HOST_API_KEY", cfg.agentHostApiKeyExpiresAt);
  warnIfNear("FILES_API_KEY", cfg.filesApiKeyExpiresAt);
  if (cfg.provider.kind === "anthropic-foundry") {
    warnIfNear("ANTHROPIC_FOUNDRY_API_KEY", cfg.provider.apiKeyExpiresAt);
  } else {
    warnIfNear("ANTHROPIC_API_KEY", cfg.provider.apiKeyExpiresAt);
  }

  console.info(`provider resolved: kind=${cfg.provider.kind}`);
  if (cfg.logLevel === "debug" && cfg.provider.kind === "anthropic-foundry") {
    const r = cfg.provider.resource;
    const last4 = r.length > 4 ? r.slice(-4) : r;
    console.debug(`provider foundry resource (redacted): …${last4}`);
  }

  const workspace = createWorkspaceManager({
    root: cfg.workspaceDir, maxBytesPerChat: cfg.workspaceMaxBytesPerChat,
  });
  const filesApi = cfg.filesApiBaseUrl !== undefined && cfg.filesApiKey !== undefined
    ? {
        baseUrl: cfg.filesApiBaseUrl,
        apiKey: cfg.filesApiKey,
        pathTemplate: cfg.filesApiPathTemplate,
        maxBytes: cfg.maxRemoteFetchBytes,
        timeoutMs: cfg.urlFetchTimeoutMs,
      }
    : undefined;
  if (filesApi === undefined) {
    console.info("files API disabled: FILES_API_BASE_URL/FILES_API_KEY not set; files[] entries on requests will be rejected with upstream_files_fetch_failed");
  }
  const attachmentProcessor = createAttachmentProcessor({
    workspace,
    filesApi,
    remote: {
      maxBytes: cfg.maxRemoteFetchBytes, timeoutMs: cfg.urlFetchTimeoutMs,
      maxFetchesPerTurn: cfg.maxUrlFetchesPerTurn,
    },
    maxInlineImageBytes: 20 * 1024 * 1024,
  });
  const agentRunner = createClaudeCodeRunner({
    provider: cfg.provider,
    maxTurns: cfg.agentMaxTurns,
    timeoutMs: cfg.agentTimeoutMs,
  });

  const app = buildApp({
    apiKey: cfg.agentHostApiKey,
    modelIds: cfg.modelIds,
    modelPrefix: cfg.modelPrefix,
    workspaceDir: cfg.workspaceDir,
    attachmentProcessor,
    agentRunner,
    responsesToolUseRendering: cfg.responsesToolUseRendering,
  });

  const listenHost = "0.0.0.0";
  await app.listen({ host: listenHost, port: cfg.listenPort });
  // One-shot human-readable banner — bound URL + every env var the service
  // reads, with secrets masked (AGENT_HOST_API_KEY intentionally revealed so
  // the operator can grab it from the log to authenticate the first request).
  printStartupBanner({
    listenHost,
    listenPort: cfg.listenPort,
    modelIds: cfg.modelIds,
    providerKind: cfg.provider.kind,
  });
  app.log.info(`agent-host listening on :${cfg.listenPort} models=${cfg.modelIds.join(",")}`);
};

main().catch(err => { console.error(err); process.exit(78); });
