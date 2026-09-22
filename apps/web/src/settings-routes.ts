import type { ModelProviderConfig, ModelRoutePolicy } from "@course-os/contracts";

type RouteCandidate = NonNullable<ModelRoutePolicy["routes"]>[number];
type ProviderPatch = Partial<Pick<ModelProviderConfig, "displayName" | "baseUrl" | "enabled" | "models">>;

export function addModelRoute(policy: ModelRoutePolicy, providers: ModelProviderConfig[], providerId?: string): ModelRoutePolicy {
  const routes = policy.routes || [];
  if (routes.length >= 12) return policy;
  const available = providers.find((provider) => provider.models.length > 0
    && (providerId ? provider.id === providerId : true)
    && !routes.some((route) => route.providerId === provider.id));
  if (!available) return policy;
  return { ...policy, routes: [...routes, { providerId: available.id, modelId: available.models[0]!.id, enabled: false }] };
}

export function updateModelRoute(policy: ModelRoutePolicy, index: number, patch: Partial<RouteCandidate>, providers: ModelProviderConfig[]): ModelRoutePolicy {
  const routes = policy.routes || [];
  const current = routes[index];
  if (!current) return policy;
  const next = { ...current, ...patch };
  const provider = providers.find((item) => item.id === next.providerId);
  if (!provider?.models.some((model) => model.id === next.modelId)) return policy;
  if (routes.some((route, routeIndex) => routeIndex !== index && route.providerId === next.providerId)) return policy;
  return { ...policy, routes: routes.map((route, routeIndex) => routeIndex === index ? next : route) };
}

export function moveModelRoute(policy: ModelRoutePolicy, index: number, direction: -1 | 1): ModelRoutePolicy {
  const routes = [...(policy.routes || [])];
  const target = index + direction;
  if (index < 0 || index >= routes.length || target < 0 || target >= routes.length) return policy;
  [routes[index], routes[target]] = [routes[target]!, routes[index]!];
  return { ...policy, routes };
}

export function removeModelRoute(policy: ModelRoutePolicy, index: number): ModelRoutePolicy {
  const routes = policy.routes || [];
  if (index < 0 || index >= routes.length) return policy;
  const remaining = routes.filter((_, routeIndex) => routeIndex !== index);
  if (remaining.length > 0) return { ...policy, routes: remaining };
  // Omitting the ordered chain keeps the existing per-stage rules active.
  const { routes: _removed, ...withoutRoutes } = policy;
  return withoutRoutes;
}

export function addModelProvider(providers: ModelProviderConfig[], provider: ModelProviderConfig): ModelProviderConfig[] {
  if (providers.some((item) => item.id === provider.id)) return providers;
  return [...providers, structuredClone(provider)];
}

export function updateModelProvider(providers: ModelProviderConfig[], providerId: string, patch: ProviderPatch): ModelProviderConfig[] {
  if (!providers.some((item) => item.id === providerId)) return providers;
  return providers.map((item) => item.id === providerId ? { ...item, ...patch, id: item.id } : item);
}

export function removeModelProvider(providers: ModelProviderConfig[], providerId: string): ModelProviderConfig[] {
  if (!providers.some((item) => item.id === providerId)) return providers;
  return providers.filter((item) => item.id !== providerId);
}
