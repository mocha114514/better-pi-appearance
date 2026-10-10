import { join } from "node:path";
import type {
    Api,
    Model,
    Provider,
    StreamOptions,
} from "@earendil-works/pi-ai";
import {
    getAgentDir,
    type ExtensionAPI,
    type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { t } from "../shared/i18n/index.ts";
import { loadWsRules, type WsRules } from "./config.ts";
import { createWsFetch } from "./fetch-adapter.ts";
import { ResponsesWsPool } from "./ws-client.ts";

const RESPONSES_API = "openai-responses";

/** A model's private transport flag never changes its native API identity. */
export function shouldUseWs(model: Model<Api>, rules: WsRules): boolean {
    return model.api === RESPONSES_API && rules.enabled(model.provider, model.id);
}

/**
 * Wrap existing providers instead of replacing their model/auth definitions.
 * Both native streaming entrypoints are retained: this also preserves advanced
 * stream() options and the exact non-WS behavior of the original provider.
 */
export default function responsesWsExtension(pi: ExtensionAPI): void {
    if (!isPluginEnabled("responses-ws")) return;

    let pool: ResponsesWsPool | undefined;
    let registry: ModelRegistry | undefined;
    const installed = new Map<string, Provider>();
    let generation = 0;

    const dispose = () => {
        generation++;
        pool?.dispose();
        pool = undefined;
        if (registry) {
            for (const [providerId, wrapper] of installed) {
                // Registration is not a stack. Never remove another extension
                // that took ownership of this provider after our installation.
                if (registry.getRegisteredNativeProvider(providerId) === wrapper) {
                    pi.unregisterProvider(providerId);
                }
            }
        }
        installed.clear();
        registry = undefined;
    };

    pi.on("session_start", async (_event, ctx) => {
        dispose();
        const startupGeneration = generation;
        let rules: WsRules;
        try {
            // Only read transport flags. Pi remains responsible for resolving
            // credentials, endpoints, model metadata, and effective headers.
            rules = await loadWsRules(join(getAgentDir(), "models.json"));
        } catch (error) {
            if (startupGeneration !== generation) return;
            ctx.ui.notify(t("responsesWs.configFailed", {
                error: error instanceof Error ? error.message : "Invalid transport configuration",
            }), "error");
            return;
        }
        // A shutdown or newer startup can supersede the asynchronous file
        // read. Never install a late wrapper into a closed/stale context.
        if (startupGeneration !== generation || rules.providers.size === 0) return;
        registry = ctx.modelRegistry;

        const transport = new ResponsesWsPool();
        pool = transport;

        for (const providerId of rules.providers) {
            if (registry.getRegisteredProviderConfig(providerId) ||
                registry.getRegisteredNativeProvider(providerId)) {
                ctx.ui.notify(t("responsesWs.conflict", { provider: providerId }), "error");
                continue;
            }

            const original = registry.getProvider(providerId);
            if (!original?.getModels().some((model) => shouldUseWs(model, rules))) {
                ctx.ui.notify(t("responsesWs.noModel", { provider: providerId }), "warning");
                continue;
            }

            const withTransport = <T extends StreamOptions>(
                model: Model<Api>,
                options: T | undefined,
            ): T | undefined => {
                if (!shouldUseWs(model, rules)) return options;
                const hookAbort = new AbortController();
                const transportSignal = options?.signal
                    ? AbortSignal.any([options.signal, hookAbort.signal])
                    : hookAbort.signal;
                const originalOnResponse = options?.onResponse;
                const onResponse: StreamOptions["onResponse"] = originalOnResponse
                    ? async (response, requestedModel) => {
                        try {
                            await originalOnResponse(response, requestedModel);
                        } catch (error) {
                            // Pi has not started reading the SDK body yet. Close
                            // the unread lease, but keep options.signal unchanged
                            // so Pi reports the hook's error, not a user abort.
                            hookAbort.abort();
                            throw error;
                        }
                    }
                    : undefined;
                return {
                    ...options,
                    ...(onResponse ? { onResponse } : {}),
                    fetch: createWsFetch(transport, {
                        provider: model.provider,
                        // Prompt-cache policy does not govern transport reuse.
                        // Pi still receives the original cacheRetention option.
                        sessionId: options?.sessionId ?? ctx.sessionManager.getSessionId(),
                        env: options?.env,
                        signal: transportSignal,
                        timeoutMs: options?.timeoutMs,
                        websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
                    }),
                } as T;
            };

            const wrapper: Provider = {
                ...original,
                stream: (model, context, options) => original.stream(
                    model,
                    context,
                    withTransport(model, options),
                ),
                streamSimple: (model, context, options) => original.streamSimple(
                    model,
                    context,
                    withTransport(model, options),
                ),
            };

            try {
                // Track ownership before registration in case the host callback
                // throws after it has already installed this native provider.
                installed.set(providerId, wrapper);
                pi.registerProvider(wrapper);
                if (!registry.getProvider(providerId)) {
                    // A composition failure must not leave a broken wrapper in
                    // the registry. Preserve the original built-in/JSON layer.
                    if (registry.getRegisteredNativeProvider(providerId) === wrapper) {
                        pi.unregisterProvider(providerId);
                    }
                    installed.delete(providerId);
                    ctx.ui.notify(t("responsesWs.installFailed", { provider: providerId }), "error");
                }
            } catch {
                if (registry.getRegisteredNativeProvider(providerId) === wrapper) {
                    pi.unregisterProvider(providerId);
                }
                installed.delete(providerId);
                ctx.ui.notify(t("responsesWs.installFailed", { provider: providerId }), "error");
            }
        }
    });

    // Pi emits shutdown before invalidating the old extension context on reload.
    // Dispose here, not in a process-wide exit handler or global fetch patch.
    pi.on("session_shutdown", dispose);
}
