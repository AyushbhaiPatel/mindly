import { systemClock, type Clock } from '@mindly/core';
import { openDatabase, transaction, type Db, type OpenOptions } from './db.js';
import { CheckpointRepo } from './repos/checkpoints.js';
import { EventRepo, ProjectRepo, SessionRepo } from './repos/core.js';
import { IdRepo } from './repos/ids.js';
import { MemoryRepo } from './repos/memories.js';
import { SaveRepo } from './repos/saves.js';
import { SentinelRepo } from './repos/sentinel.js';
import {
  ContextPacketRepo,
  ContractRepo,
  HandoffRepo,
  KvRepo,
  RunRepo,
  SnapshotRepo,
} from './repos/misc.js';
import { SplitRepo } from './repos/splits.js';
import { TrackRepo } from './repos/track.js';
import { ConflictRepo, DeliveryRepo, FileChangeRepo, IntentRepo, TaskRepo } from './repos/work.js';

export * from './db.js';
export * from './glance.js';
export { MIGRATIONS } from './migrations.js';
export * from './repos/checkpoints.js';
export * from './repos/core.js';
export * from './repos/ids.js';
export * from './repos/memories.js';
export * from './repos/misc.js';
export * from './repos/saves.js';
export * from './repos/sentinel.js';
export * from './repos/splits.js';
export * from './repos/track.js';
export * from './repos/work.js';

/**
 * All repositories over one database connection. Construct one per process; it is cheap to keep
 * open and safe to share across async work in that process (node:sqlite is synchronous).
 */
export class Store {
  readonly projects: ProjectRepo;
  readonly sessions: SessionRepo;
  readonly events: EventRepo;
  readonly memories: MemoryRepo;
  readonly tasks: TaskRepo;
  readonly intents: IntentRepo;
  readonly fileChanges: FileChangeRepo;
  readonly conflicts: ConflictRepo;
  readonly deliveries: DeliveryRepo;
  readonly contextPackets: ContextPacketRepo;
  readonly handoffs: HandoffRepo;
  readonly contracts: ContractRepo;
  readonly snapshots: SnapshotRepo;
  readonly runs: RunRepo;
  readonly kv: KvRepo;
  readonly saves: SaveRepo;
  readonly splits: SplitRepo;
  readonly checkpoints: CheckpointRepo;
  /** Read models of `mindly track` and the line survival table. */
  readonly track: TrackRepo;
  /** The sentinel's watched working trees (`mindly sentinel`). */
  readonly sentinel: SentinelRepo;
  /** Resolves full, short and prefix ids typed by people (CLI, dashboard search). */
  readonly ids: IdRepo;

  constructor(
    readonly db: Db,
    readonly clock: Clock = systemClock,
  ) {
    this.projects = new ProjectRepo(db, clock);
    this.sessions = new SessionRepo(db, clock);
    this.events = new EventRepo(db, clock);
    this.memories = new MemoryRepo(db, clock);
    this.tasks = new TaskRepo(db, clock);
    this.intents = new IntentRepo(db, clock);
    this.fileChanges = new FileChangeRepo(db, clock);
    this.conflicts = new ConflictRepo(db, clock);
    this.deliveries = new DeliveryRepo(db, clock);
    this.contextPackets = new ContextPacketRepo(db, clock);
    this.handoffs = new HandoffRepo(db, clock);
    this.contracts = new ContractRepo(db, clock);
    this.snapshots = new SnapshotRepo(db, clock);
    this.runs = new RunRepo(db, clock);
    this.kv = new KvRepo(db, clock);
    this.saves = new SaveRepo(db, clock);
    this.splits = new SplitRepo(db, clock);
    this.checkpoints = new CheckpointRepo(db, clock);
    this.track = new TrackRepo(db, clock);
    this.sentinel = new SentinelRepo(db, clock);
    this.ids = new IdRepo(db);
  }

  static open(path: string, options: OpenOptions & { clock?: Clock } = {}): Store {
    return new Store(openDatabase(path, options), options.clock ?? systemClock);
  }

  /** In-memory store for tests. */
  static memory(clock: Clock = systemClock): Store {
    return new Store(openDatabase(':memory:'), clock);
  }

  transaction<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** Reclaims space after large deletions (`mindly forget`). */
  vacuum(): void {
    this.db.exec('VACUUM');
  }
}
