# Dispatch Web specification

**Status: draft outline.** The first implementation slice is undecided. This file will define the package's agreed behavior and contracts; its existence does not make unresolved details accepted.

## Product context

Dispatch Web is the browser workspace for general-purpose client problem-solving with agents. It uses stock Pi Durable for durable execution and recovery. The maintained product account and previous decisions are linked from the [repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/).

## First workflow and observable outcomes

To be specified with Chris: the actor, goal, entry point, successful outcome, alternative paths, and initial scope.

## Contracts and state ownership

To be specified: application interfaces, state ownership, native Pi Durable operations, configuration semantics, and the boundaries between the browser, application, and runtime.

## Failure and recovery behavior

To be specified for the chosen workflow, including observable failures, retries, interruption, and recovery.

## Acceptance

Once the first workflow and its contracts are agreed, record work-package acceptance criteria and checks in [handoff.md](handoff.md), with executable coverage in the [package tests](../test/). There is no separate validation plan.
