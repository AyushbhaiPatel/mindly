import type { Synapse, SynapseModule } from '../synapse.js';
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
export const defaultModules: readonly SynapseModule[] = [
  impactModule,
  selfHealingModule,
  contractsModule,
  provenanceModule,
  xrayModule,
];

/** Installs `defaultModules` on a `Synapse` instance. Call once per instance. */
export function installDefaultModules(synapse: Synapse): Synapse {
  for (const m of defaultModules) synapse.use(m);
  return synapse;
}

/*
 * Accessors for the attached services. When a module was not installed, a service is created on
 * first access (without bus handlers), so CLI/MCP callers can always use the API.
 */

/** The impact radar service of `synapse`. */
export function impactOf(synapse: Synapse): ImpactService {
  return serviceOf(synapse, 'impact', () => new ImpactService(synapse.kernel, synapse.telepathy));
}

/** The self-healing memory service of `synapse`. */
export function selfHealingOf(synapse: Synapse): SelfHealingService {
  return serviceOf(
    synapse,
    'self-healing',
    () => new SelfHealingService(synapse.kernel, synapse.memory, synapse.telepathy),
  );
}

/** The executable-memory (contracts) service of `synapse`. */
export function contractsOf(synapse: Synapse): ContractService {
  return serviceOf(
    synapse,
    'contracts',
    () => new ContractService(synapse.kernel, synapse.telepathy),
  );
}

/** The code provenance service of `synapse`. */
export function provenanceOf(synapse: Synapse): ProvenanceService {
  return serviceOf(synapse, 'provenance', () => new ProvenanceService(synapse.kernel));
}

/** The Context X-Ray service of `synapse`. */
export function xrayOf(synapse: Synapse): XRayService {
  return serviceOf(synapse, 'xray', () => new XRayService(synapse.kernel));
}
