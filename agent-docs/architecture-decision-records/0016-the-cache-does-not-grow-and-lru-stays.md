# ADR 0016 — The cache does not grow, and LRU stays

Status: Accepted (no code change; records the retention audit and closes the
"use a better eviction algorithm" question)

## Context

ADR 0015 raised `DEFAULT_MAX_CACHE_BYTES` to 1 GB. A ceiling that size invites
two fair questions, and neither should be answered by reasoning:

1. Does memory actually stay bounded as a user scrolls into new regions over a
   long session — or does something creep?
2. Is LRU the right policy? Panning to new areas is a **scan**, and scan
   eviction is the workload LRU is famously worst at.

## 1. Retention — measured three ways, no growth

**Revisiting a fixed set of windows.** 240 windows, six laps, shipped defaults:

| corpus           |         RSS |  cache held | entries |
| ---------------- | ----------: | ----------: | ------: |
| `200x.shortread` | 603 MB flat | 331 MB flat |      33 |
| `1000x.longread` | 943 MB flat | 573 MB flat |      60 |

Flat from lap 2 onward. **But this proves less than it looks like**: on those
fixtures the file's whole chunk set fits under 1 GB, so eviction never ran once.
A plateau here is arithmetic, not evidence.

**New areas, budget deliberately binding.** 200 MB budget against the same
file's 573 MB chunk set, 200 windows marching into fresh territory:

- `totalSize` pinned at **181 MB across all 200 windows**, never once over
  budget. Eviction holds the line.
- It holds exactly **one entry**, because a single chunk there is 181 MB — the
  ADR 0014 inversion, reproduced deliberately.

**Real-time reclamation**, real timers rather than fake ones: after panning,
held 331 MB → **0 MB** once idle, and the process exits on its own — which is
simultaneously the proof that the sweep timer stops itself and that it never
holds the event loop open.

**The only other per-query map** is `memoizeByRefId` (`indexFile.ts`), keyed by
reference sequence, so it is bounded by chromosome count and not by regions
visited.

## 2. LRU stays — the scan problem is a symptom, not a cause

Workload: a "home" window the user keeps returning to, interleaved with sweeps
through eight far-away windows, ten times. Counts re-reads of _home_:

| budget         | home re-reads over 10 returns | held   |
| -------------- | ----------------------------: | ------ |
| 100 MB (old)   |                        **47** | 88 MB  |
| 200 MB         |                         **0** | 196 MB |
| 400 MB         |                             0 | 314 MB |
| 1024 MB (ship) |                         **0** | 314 MB |

LRU's scan-vulnerability is real and severe — **and it vanishes entirely above
the working set**. At the shipped default there is no eviction pressure on
realistic data, so W-TinyLFU, 2Q, ARC or any size-aware admission policy would
change nothing at all. The scan problem was a symptom of the undersized budget,
which ADR 0014 already fixed.

## Decision

Keep `'lru'`. Do not adopt a scan-resistant or size-aware policy.

## Don't re-attempt without

A workload where eviction actually runs at the shipped defaults. The 47 re-reads
in the 100 MB row are what a better policy would recover, and that row is now a
configuration the docs tell people not to use. If someone genuinely needs a
constrained budget — a memory-limited embedding — that is the case where
W-TinyLFU or 2Q would earn their complexity, and it should be measured against
that row rather than against the defaults.

## What this does NOT establish

Peak memory is still unbounded by any of this, and no policy changes that. Six
in-flight reads on 1000x long-read data is 476 MB before retention holds
anything, because the unit of decompression is the chunk and a chunk there is
180 MB. The 200 MB-budget run above shows the shape plainly: 181 MB retained,
RSS fluctuating between 633 MB and 849 MB.
