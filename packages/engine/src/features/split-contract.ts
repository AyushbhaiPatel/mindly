import { sanitizeLine, type Split, type SplitContractItem } from '@mindly/core';
import type { Kernel } from '../kernel.js';

/*
 * The shared contract of a split lives in decision memories, one per item, so the user can edit,
 * reject or archive them like any decision. The split row keeps the planned items and the memory
 * ids; whatever is shown (status, briefs, API, MCP) is read back from the memories, so an edit
 * shows at once and an item that is no longer approved disappears.
 */

/** Prefix on every contract decision's title: a contract item never merges into another decision. */
export function contractTitle(slug: string, name: string): string {
  return `[split ${slug}] ${name}`;
}

function contractName(slug: string, title: string): string {
  const prefix = contractTitle(slug, '');
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}

/** Merge-conflict fingerprints of a split start with this, so the daemon's own merge job leaves them alone. */
export const SPLIT_FINGERPRINT_PREFIX = 'split:';

/** The contract items that are still approved decisions, with their current title and text. */
export function liveContract(store: Kernel['store'], split: Split): SplitContractItem[] {
  const out: SplitContractItem[] = [];
  for (const item of split.contract) {
    if (item.memoryId === null) {
      out.push(item);
      continue;
    }
    const m = store.memories.find(item.memoryId);
    if (!m || m.status !== 'active' || m.trust !== 'approved') continue;
    out.push({ ...item, name: contractName(split.slug, m.title), definition: m.body });
  }
  return out;
}

export function contractLines(contract: readonly SplitContractItem[]): string[] {
  return contract.map(
    (c) =>
      `${sanitizeLine(c.name, 120)} \u2014 ${sanitizeLine(c.definition, 400)} (owned by part ${c.owner})`,
  );
}
