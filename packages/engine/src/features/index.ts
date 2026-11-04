import type { Mindly, MindlyModule } from '../mindly.js';
import { contractsModule, ContractService } from './contracts.js';
import { impactModule, ImpactService } from './impact.js';
import { provenanceModule, ProvenanceService } from './provenance.js';
import { selfHealingModule, SelfHealingService } from './self-healing.js';
import { serviceOf } from './shared.js';
import { xrayModule, XRayService } from './xray.js';

export * from './contracts.js';
export * from './impact.js';
export * from './provenance.js';
export * from './self-healing.js';
export * from './xray.js';

/** The feature modules every entry point installs by default, in registration order. */
export const defaultModules: readonly MindlyModule[] = [
  impactModule,
  selfHealingModule,
  contractsModule,
  provenanceModule,
  xrayModule,
];

/** Installs `defaultModules` on a `Mindly` instance. Call once per instance. */
export function installDefaultModules(mindly: Mindly): Mindly {
  for (const m of defaultModules) mindly.use(m);
  return mindly;
}

/*
 * Accessors for the attached services. When a module was not installed, a service is created on
 * first access (without bus handlers), so CLI/MCP callers can always use the API.
 */

/** The impact radar service of `mindly`. */
export function impactOf(mindly: Mindly): ImpactService {
  return serviceOf(mindly, 'impact', () => new ImpactService(mindly.kernel, mindly.telepathy));
}

/** The self-healing memory service of `mindly`. */
export function selfHealingOf(mindly: Mindly): SelfHealingService {
  return serviceOf(
    mindly,
    'self-healing',
    () => new SelfHealingService(mindly.kernel, mindly.memory, mindly.telepathy),
  );
}

/** The executable-memory (contracts) service of `mindly`. */
export function contractsOf(mindly: Mindly): ContractService {
  return serviceOf(mindly, 'contracts', () => new ContractService(mindly.kernel, mindly.telepathy));
}

/** The code provenance service of `mindly`. */
export function provenanceOf(mindly: Mindly): ProvenanceService {
  return serviceOf(mindly, 'provenance', () => new ProvenanceService(mindly.kernel));
}

/** The Context X-Ray service of `mindly`. */
export function xrayOf(mindly: Mindly): XRayService {
  return serviceOf(mindly, 'xray', () => new XRayService(mindly.kernel));
}
