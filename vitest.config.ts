import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // a live agent worktree under .claude/ is another checkout of this
    // repo, and vitest's include glob matches dotfolders
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    // Vitest's default is 5s, and several tests here do real work against real
    // BAMs: the samtools agreement tests run 1.6-2.4s each and
    // test/cache.test.ts's byte-budget test runs ~0.9s, decompressing tens of
    // megabytes of the 18MB out.bam. Measured on a quiet machine those sit at
    // 2-6x under the default, which is thinner than it looks — the number that
    // matters is not the unloaded time but the time on a contended runner.
    //
    // 20s is ~8x the slowest test rather than a round number pulled from the
    // air. It is not covering for a slow test: nothing here is near it under
    // any load a CI runner plausibly produces (24 concurrent copies of
    // cache.test.ts on 16 cores only reached 4.9s). It exists so that a
    // loaded runner reports the failure the suite actually has, instead of a
    // timeout on whichever test happened to be running.
    //
    // Kept deliberately finite: the cancellation tests in test/cache.test.ts
    // express a real bug as a hang — a read no caller can release — so a
    // timeout is their failure mode and must still arrive.
    testTimeout: 20_000,
  },
})
