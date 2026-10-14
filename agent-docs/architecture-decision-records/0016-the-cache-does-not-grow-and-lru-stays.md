# ADR 0016 — The cache does not grow, and LRU stays

Status: Accepted (no code change; records the retention audit and closes the
"use a better eviction algorithm" question)

## Context

ADR 0015 raised `DEFAULT_MAX_CACHE_BYTES` to 1 GB. A ceiling that size invites
two fair questions, and both need a measurement rather than an argument:

1. Does memory actually stay bounded as a user scrolls into new regions over a
   long session, or does something creep?
2. Is LRU the right policy? Panning to new areas is a **scan**, and scans are
   the workload LRU handles worst.

## 1. Retention — measured three ways, no growth

**Revisiting a fixed set of windows.** We ran 240 windows for six laps at the
shipped defaults:

| corpus           |         RSS |  cache held | entries |
| ---------------- | ----------: | ----------: | ------: |
| `200x.shortread` | 603 MB flat | 331 MB flat |      33 |
| `1000x.longread` | 943 MB flat | 573 MB flat |      60 |

RSS and cache held are flat from lap 2 onward. **The plateau proves less than it
looks like**, because on those fixtures the file's whole chunk set fits under 1
GB, so eviction never ran once and the plateau follows from the chunk set's size
alone.

**New areas, with the budget deliberately binding.** We set a 200 MB budget
against the same file's 573 MB chunk set and moved through 200 windows into
regions not yet visited:

- `totalSize` stays at **181 MB across all 200 windows** and never once goes
  over budget, so eviction keeps retention under the budget.
- The cache holds exactly **one entry**, because a single chunk there is 181 MB.
  The run reproduces ADR 0014's below-working-set case on purpose.

**Real-time reclamation.** With real timers rather than fake ones, the cache
held 331 MB after panning and **0 MB** once idle, and the process exits on its
own. The exit shows both that the sweep timer stops itself and that it never
holds the event loop open.

**The only other per-query map** is `memoizeByRefId` (`indexFile.ts`), keyed by
reference sequence, so it is bounded by chromosome count and not by regions
visited.

## 2. LRU stays — the scan problem is a symptom, not a cause

The workload is a "home" window the user keeps returning to, interleaved with
sweeps through eight far-away windows, ten times. The table counts re-reads of
_home_:

| budget         | home re-reads over 10 returns | held   |
| -------------- | ----------------------------: | ------ |
| 100 MB (old)   |                        **47** | 88 MB  |
| 200 MB         |                         **0** | 196 MB |
| 400 MB         |                             0 | 314 MB |
| 1024 MB (ship) |                         **0** | 314 MB |

LRU's weakness on scans is real and severe, **and it vanishes entirely above the
working set**. At the shipped default there is no eviction pressure on realistic
data, so W-TinyLFU, 2Q, ARC or any size-aware admission policy would change
nothing at all. The scan problem was a symptom of the undersized budget, which
ADR 0014 already fixed.

## Decision

Keep `'lru'`. Do not adopt a scan-resistant or size-aware policy.

## Don't re-attempt without

A workload where eviction runs at the shipped defaults. The 47 re-reads in the
100 MB row are what a better policy would recover, and that row is now a
configuration the docs tell people not to use. A consumer that needs a
constrained budget, such as a memory-limited embedding, is the case where
W-TinyLFU or 2Q would justify their complexity, and that case should be measured
against the 100 MB row rather than against the defaults.

## What this does not establish

Peak memory is still unbounded by any of this, and no policy changes that. Six
in-flight reads on 1000x long-read data is 476 MB before retention holds
anything, because the unit of decompression is the chunk and a chunk there is
180 MB. The 200 MB-budget run above shows the pattern: it retains 181 MB while
RSS fluctuates between 633 MB and 849 MB.
