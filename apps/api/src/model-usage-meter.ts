import { ModelRouterGenerationError, type ModelRouterClient, type ModelRouterUsage } from "./model-router.js";

type UsageReceipt = { provider: string; model: string; usage: ModelRouterUsage };

/** Receipts outlive content validation and cancellation; no draft writes happen here. */
export function meterModelRouter(upstream: ModelRouterClient): { client: ModelRouterClient; groupedUsage(): UsageReceipt[] } {
  const receipts: UsageReceipt[] = [];
  const observe = async <T extends UsageReceipt>(call: () => Promise<T>): Promise<T> => {
    try {
      const result = await call();
      receipts.push({ provider: result.provider, model: result.model, usage: structuredClone(result.usage) });
      return result;
    } catch (error) {
      if (error instanceof ModelRouterGenerationError) receipts.push({ provider: error.provider, model: error.model, usage: structuredClone(error.usage) });
      throw error;
    }
  };
  const client: ModelRouterClient = {
    generateTeachingPackage: input => observe(() => upstream.generateTeachingPackage(input)),
    ...(upstream.repairTeachingFields ? { repairTeachingFields: ((input, fields) => observe(() => upstream.repairTeachingFields!(input, fields))) as NonNullable<ModelRouterClient["repairTeachingFields"]> } : {}),
    ...(upstream.auditTeachingPackage ? { auditTeachingPackage: (input => observe(() => upstream.auditTeachingPackage!(input))) as NonNullable<ModelRouterClient["auditTeachingPackage"]> } : {})
  };
  return { client, groupedUsage() {
    const groups = new Map<string, UsageReceipt>();
    for (const receipt of receipts) {
      const key = JSON.stringify([receipt.provider, receipt.model]);
      const previous = groups.get(key);
      if (!previous) { groups.set(key, structuredClone(receipt)); continue; }
      const a = previous.usage, b = receipt.usage;
      a.inputTokens += b.inputTokens; a.cachedInputTokens += b.cachedInputTokens;
      a.outputTokens += b.outputTokens; a.durationMs += b.durationMs;
      a.apiEquivalentUsd = a.apiEquivalentUsd === null || b.apiEquivalentUsd === null ? null : a.apiEquivalentUsd + b.apiEquivalentUsd;
    }
    return [...groups.values()];
  } };
}
