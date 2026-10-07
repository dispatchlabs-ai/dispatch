/** Persisted admission barrier. The caller must route every authoritative writer
 * (including background jobs) through run(), not just HTTP mutations.
 * Persistence failure leaves admission disabled until process restart/recovery.
 */
export class WriteAdmission {
  private blocked: boolean;
  private active = 0;
  private persistedBlocked: boolean;
  private generation = 0;
  private settled: Array<() => void> = [];
  private transition: Promise<void> = Promise.resolve();

  constructor(initiallyBlocked: boolean, private readonly persist: (blocked: boolean) => Promise<void>) {
    this.blocked = initiallyBlocked;
    this.persistedBlocked = initiallyBlocked;
  }

  get quiesced() { return this.blocked && this.persistedBlocked && this.active === 0; }
  get admitting() { return !this.blocked; }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.blocked) throw new AdmissionClosedError();
    this.active++;
    try { return await operation(); }
    finally {
      this.active--;
      if (this.active === 0) {
        for (const resolve of this.settled.splice(0)) resolve();
      }
    }
  }

  quiesce(): Promise<void> {
    // Disable synchronously, before queuing persistence behind another transition.
    this.generation++;
    this.blocked = true;
    this.persistedBlocked = false;
    return this.change(async () => {
      this.blocked = true;
      await this.persist(true);
      this.persistedBlocked = true;
      if (this.active !== 0) await new Promise<void>(resolve => this.settled.push(resolve));
    });
  }

  resume(): Promise<void> {
    const generation = ++this.generation;
    return this.change(async () => {
      this.persistedBlocked = false;
      await this.persist(false);
      if (generation === this.generation) this.blocked = false;
    });
  }

  private change(operation: () => Promise<void>) {
    const next = this.transition.then(operation);
    this.transition = next.catch(() => { this.blocked = true; this.persistedBlocked = false; });
    return next;
  }
}

export class AdmissionClosedError extends Error {
  constructor() { super("Application writes are quiesced."); }
}
