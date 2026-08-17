#!/usr/bin/env python3
"""Minimal descriptor-driven npc-agent-jsonl/1 adapter using only Python stdlib.

The example discovers a product without starting it, starts one task-owned CLI,
sends zero or more product commands, then performs drain -> shutdown -> stopped
event -> stdout EOF. It intentionally does not hide product events or errors.
"""

from __future__ import annotations

import argparse
import json
import queue
import subprocess
import sys
import threading
import time
from typing import Any, Callable


END_OF_STREAM = object()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--send",
        action="append",
        default=[],
        metavar="JSON",
        help="product command to send after startup; may be repeated",
    )
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument(
        "--discovery-prefix-length",
        type=int,
        help="argv count to keep before appending --describe",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    if options.command and options.command[0] == "--":
        options.command = options.command[1:]
    if not options.command:
        parser.error("a product command is required after --")
    if not 0 < options.timeout <= 86400:
        parser.error("--timeout must be greater than 0 and at most 86400 seconds")
    return options


def discovery_command(options: argparse.Namespace) -> list[str]:
    prefix_length = options.discovery_prefix_length
    if prefix_length is None:
        prefix_length = next(
            (
                index
                for index, value in enumerate(options.command[1:], start=1)
                if value.startswith("--")
            ),
            len(options.command),
        )
    if not 1 <= prefix_length <= len(options.command):
        raise ValueError("--discovery-prefix-length is outside the product command")
    return [*options.command[:prefix_length], "--describe"]


def discover(options: argparse.Namespace) -> dict[str, Any]:
    completed = subprocess.run(
        discovery_command(options),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="strict",
        timeout=options.timeout,
        check=False,
    )
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if completed.returncode != 0 or len(lines) != 1:
        raise RuntimeError(
            f"--describe failed with exit {completed.returncode}: "
            f"{completed.stderr[-4096:]}"
        )
    descriptor = json.loads(lines[0])
    if descriptor.get("schema") != "npc-agent-cli-descriptor/1":
        raise RuntimeError("product returned an incompatible descriptor")
    interop = descriptor.get("capabilities", {}).get("agentInterop", {})
    if (
        interop.get("protocol") != "npc-agent-jsonl/1"
        or interop.get("commandFields", {}).get("arguments") != "args"
    ):
        raise RuntimeError("product does not advertise the expected JSONL contract")
    return descriptor


def parse_product_commands(options: argparse.Namespace, descriptor: dict[str, Any]) -> list[dict[str, Any]]:
    if options.send:
        commands = [json.loads(value) for value in options.send]
    else:
        probe = descriptor.get("operationCatalog", {}).get("safeProbe")
        if not isinstance(probe, dict):
            raise RuntimeError("descriptor has no safeProbe")
        commands = [{"id": "example-probe", "op": probe["op"], "args": probe["args"]}]
    seen: set[str] = set()
    for command in commands:
        if not isinstance(command, dict):
            raise ValueError("each --send value must be a JSON object")
        if not isinstance(command.get("id"), str) or not command["id"]:
            raise ValueError("each --send command requires a non-empty string id")
        if not isinstance(command.get("op"), str) or not command["op"]:
            raise ValueError("each --send command requires a non-empty string op")
        if not isinstance(command.get("args"), dict):
            raise ValueError("each --send command requires an args object")
        if command["op"] in {"drain", "shutdown"}:
            raise ValueError("the adapter owns drain and shutdown")
        if command["id"] in seen:
            raise ValueError(f"duplicate command id: {command['id']}")
        seen.add(command["id"])
    return commands


def read_stdout(stream: Any, incoming: queue.Queue[Any]) -> None:
    try:
        for line in stream:
            if line.strip():
                incoming.put(json.loads(line))
    except BaseException as error:
        incoming.put(error)
    finally:
        incoming.put(END_OF_STREAM)


def read_stderr(stream: Any, chunks: list[str]) -> None:
    for chunk in stream:
        chunks.append(chunk)


def emit(message: dict[str, Any]) -> None:
    print(json.dumps(message, ensure_ascii=False, separators=(",", ":")), flush=True)


def send(process: subprocess.Popen[str], command: dict[str, Any]) -> None:
    if process.stdin is None:
        raise RuntimeError("product stdin is unavailable")
    process.stdin.write(json.dumps(command, separators=(",", ":")) + "\n")
    process.stdin.flush()


def wait_for(
    incoming: queue.Queue[Any],
    predicate: Callable[[dict[str, Any]], bool],
    label: str,
    deadline: float,
) -> dict[str, Any]:
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"timed out waiting for {label}")
        item = incoming.get(timeout=remaining)
        if item is END_OF_STREAM:
            raise RuntimeError(f"stdout closed before {label}")
        if isinstance(item, BaseException):
            raise item
        emit(item)
        if predicate(item):
            return item


def wait_for_eof(incoming: queue.Queue[Any], deadline: float) -> None:
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("timed out waiting for stdout EOF")
        item = incoming.get(timeout=remaining)
        if item is END_OF_STREAM:
            return
        if isinstance(item, BaseException):
            raise item
        emit(item)


def run(options: argparse.Namespace) -> int:
    descriptor = discover(options)
    interop = descriptor["capabilities"]["agentInterop"]
    startup_event = interop["startupEvent"]
    stopped_event = interop["stoppedEvent"]
    commands = parse_product_commands(options, descriptor)
    used_ids = {command["id"] for command in commands}

    def reserved(base: str) -> str:
        value = base
        index = 1
        while value in used_ids:
            index += 1
            value = f"{base}-{index}"
        used_ids.add(value)
        return value

    drain_id = reserved("example-drain")
    shutdown_id = reserved("example-shutdown")
    process = subprocess.Popen(
        options.command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="strict",
        bufsize=1,
    )
    if process.stdout is None or process.stderr is None:
        raise RuntimeError("product pipes are unavailable")
    incoming: queue.Queue[Any] = queue.Queue()
    stderr_chunks: list[str] = []
    threading.Thread(target=read_stdout, args=(process.stdout, incoming), daemon=True).start()
    threading.Thread(target=read_stderr, args=(process.stderr, stderr_chunks), daemon=True).start()
    deadline = time.monotonic() + options.timeout
    result_code = 0
    try:
        wait_for(incoming, lambda m: m.get("event") == startup_event, startup_event, deadline)
        for command in commands:
            send(process, command)
            result = wait_for(
                incoming,
                lambda m, wanted=command["id"]: m.get("type") == "result" and m.get("id") == wanted,
                f"result {command['id']}",
                deadline,
            )
            if result.get("ok") is not True:
                result_code = 2
                break

        send(process, {"id": drain_id, "op": "drain", "args": {}})
        drained = wait_for(
            incoming,
            lambda m: m.get("type") == "result" and m.get("id") == drain_id,
            "drain result",
            deadline,
        )
        if drained.get("ok") is not True:
            result_code = 2

        send(process, {"id": shutdown_id, "op": "shutdown", "args": {}})
        if process.stdin is not None:
            process.stdin.close()
        stopped = wait_for(
            incoming,
            lambda m: m.get("type") == "result" and m.get("id") == shutdown_id,
            "shutdown result",
            deadline,
        )
        if stopped.get("ok") is not True:
            result_code = 2
        wait_for(incoming, lambda m: m.get("event") == stopped_event, stopped_event, deadline)
        wait_for_eof(incoming, deadline)
        code = process.wait(timeout=max(0.1, deadline - time.monotonic()))
        if code != 0:
            raise RuntimeError(f"product exited {code}: {''.join(stderr_chunks)[-4096:]}")
        return result_code
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)


def main() -> int:
    options = parse_args()
    try:
        return run(options)
    except BaseException as error:
        print(f"agent-jsonl-example failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
