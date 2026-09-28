import type { AgentManifest, AgentService } from './types.js';

export function createManifest(input: Partial<AgentManifest> & { services: AgentService[] }): AgentManifest {
  if (!input || typeof input !== 'object') throw new TypeError('manifest must be an object');
  for (const field of ['id', 'name', 'version']) {
    if (typeof input[field as keyof AgentManifest] !== 'string' || !(input[field as keyof AgentManifest] as string).trim()) throw new TypeError(`${field} is required`);
  }
  if (!Array.isArray(input.services)) throw new TypeError('services must be an array');
  const services = input.services.map((service) => {
    if (!service || typeof service.id !== 'string' || typeof service.type !== 'string' || !Array.isArray(service.tools)) throw new TypeError('each service needs id, type, and tools');
    return { ...service, id: service.id.trim(), type: service.type.trim(), tools: Array.from(new Set(service.tools.filter((tool): tool is string => typeof tool === 'string').map((tool) => tool.trim()).filter(Boolean))) };
  });
  return Object.freeze({ id: input.id!.trim(), name: input.name!.trim(), version: input.version!.trim(), ...(input.description ? { description: input.description.trim() } : {}), services, ...(input.registrations ? { registrations: { ...input.registrations } } : {}) });
}
