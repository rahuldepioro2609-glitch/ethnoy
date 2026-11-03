export type DashboardSectionStatus =
  | { state: 'loading' }
  | { state: 'success' }
  | { state: 'error'; error: string };

export type DashboardSectionStatusMap = Record<string, DashboardSectionStatus>;

export class DashboardSectionLoader {
  private readonly inFlight = new Map<string, Promise<void>>();
  private generation = 0;

  constructor(
    private readonly updateData: (data: Record<string, unknown>) => void,
    private readonly updateStatus: (
      update: (current: DashboardSectionStatusMap) => DashboardSectionStatusMap,
    ) => void,
  ) {}

  reset(): void {
    this.generation += 1;
    this.inFlight.clear();
    this.updateStatus(() => ({}));
  }

  load(
    key: string,
    request: () => Promise<Record<string, unknown>>,
  ): Promise<void> {
    const activeRequest = this.inFlight.get(key);
    if (activeRequest) return activeRequest;

    const generation = this.generation;
    this.updateStatus((current) => ({ ...current, [key]: { state: 'loading' } }));

    const task = Promise.resolve().then(async () => {
      try {
        const data = await request();
        if (generation !== this.generation) return;
        this.updateData(data);
        this.updateStatus((current) => ({ ...current, [key]: { state: 'success' } }));
      } catch (error) {
        if (generation !== this.generation) return;
        this.updateStatus((current) => ({
          ...current,
          [key]: {
            state: 'error',
            error: error instanceof Error ? error.message : 'Could not load this section.',
          },
        }));
      } finally {
        if (this.inFlight.get(key) === task) this.inFlight.delete(key);
      }
    });

    this.inFlight.set(key, task);
    return task;
  }
}
