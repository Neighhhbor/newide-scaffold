# newIDE-BCD

`newIDE-BCD` is the v0 TypeScript scaffold for running a minimal A/B/C/D end-to-end flow:

```text
TaskCreateRequest
-> RunCreated
-> DriverSessionStarted
-> ContextPackBuilt
-> DriverRunResult
-> ArtifactRegistered
-> TaskCompletedEvent
-> HookMatched
-> GateRequest
-> GateResult
-> CouncilDecision
-> MergeAuthorization
-> CheckpointSaved
-> RunCompleted
```

The first version uses mock implementations, but the objects, interfaces, event names, and module boundaries are real v0 contracts.

## Repository Shape

This is intentionally a single-package TypeScript project. It does not use `packages/core`, `packages/runtime`, Nx, Turborepo, or a multi-package workspace. The v0 goal is to keep TypeScript project complexity low while the team proves the first end-to-end flow.

The RFC files live beside this repository in `../RFC`. They are design inputs and should not be migrated into this repository.

```text
src/
  core/         shared contracts only
  coordinator/  Direction C coordination layer (task state, checkpoint, stores)
  council/      Direction C council contracts plus MockCouncil
  driver/       Direction A driver contract plus MockDriver
  memory/       Direction B context pack contract plus MockMemoryProvider
  hook/         Direction D.1 hook system
  gate/         Direction D.2 gate evaluation system
  examples/     runnable demos
```

## Install And Run

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm format
pnpm example:basic
```

`pnpm example:basic` prints the v0 flow timeline and IDs.

## Module Responsibilities

`src/core` owns shared contracts: IDs, timestamps, task/run state, events, artifacts, checkpoints, decisions, merge authorization, messages, role and memory refs, context pack refs, and file leases. It must not import `coordinator`, `driver`, `memory`, `hook`, `gate`, or `council`.

`src/driver` owns Direction A's runtime boundary. v0 defines `DriverRuntimeHandle`, `DriverCapabilities`, `DriverPrompt`, `DriverRunResult`, `DriverError`, and `MockDriver`. Real ACP, adapter, and PTY integrations should be added behind these contracts later.

`src/memory` owns Direction B's runtime-facing context contract. v0 builds auditable `ContextPack` objects for driver, gate, and council use. It does not implement long-term memory, skill promotion, persona induction, agent splitting, or skill markets.

`src/hook` owns Direction D.1 hook system. Hook decides when to trigger gate evaluation based on events.

`src/gate` owns Direction D.2 gate evaluation system. Gate decides how to evaluate requests. The v0 implementation supports explicit `GateResult.decision` and aggregation priority `deny > ask > defer > allow`.

`src/council` owns the Council contract from Direction C. v0 accepts proposals and evidence, then returns a structured decision. It does not merge code, bypass gates, write long-term memory, or perform multi-agent debate.

`src/coordinator` owns Direction C coordination layer. It manages task state machine, checkpoints, event store, artifact store, and orchestration. Current stores are in-memory and intentionally small.

## Development Boundaries

Cross-module imports should go through module entrypoints:

```ts
import { Task, Event } from '../core';
import { MockDriver } from '../driver';
import { MockMemoryProvider } from '../memory';
import { HookEngine } from '../hook';
import { MockAllowGate } from '../gate';
```

Avoid importing another module's internal files directly. For example, prefer `../memory` over `../memory/mock-memory`.

`src/core` is the shared protocol layer. It must not import from other modules.

## Where Each Direction Works Next

Direction A should work in `src/driver`.

Direction B should work in `src/memory`.

Direction C coordination and long-running state should work in `src/coordinator` and shared types in `src/core`.

Direction C Council should work in `src/council`.

Direction D.1 should work in `src/hook`.

Direction D.2 should work in `src/gate`.

Shared object changes belong in `src/core` and should be reviewed by the relevant consuming direction.
