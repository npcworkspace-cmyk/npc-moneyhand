#!/usr/bin/env python3
"""Descriptor-driven black-box npc-agent-jsonl/1 consumer using only Python stdlib."""

from __future__ import annotations

import argparse
import json
import queue
import subprocess
import sys
import threading
import time
from typing import Any, Callable


LIFECYCLE_OPERATIONS = ["capabilities", "status", "cancel", "drain", "shutdown"]
CATALOG_SCHEMA = "npc-agent-operation-catalog/1"
CATALOG_EFFECTS = {
    "caller-dependent",
    "external-read",
    "external-write",
    "filesystem-write",
    "local-state",
    "process-control",
    "process-lifecycle",
}
UNSAFE_PROBE_EFFECTS = {
    "external-write",
    "filesystem-write",
    "caller-dependent",
    "local-state",
    "process-control",
    "process-lifecycle",
}
END_OF_STREAM = object()


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--name",
        help="optional assertion for the product name discovered through --describe",
    )
    parser.add_argument(
        "--startup",
        help="optional assertion for the startup event discovered through --describe",
    )
    parser.add_argument(
        "--stopped",
        help="optional assertion for the stopped event discovered through --describe",
    )
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument("--discovery-prefix-length", type=int)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    if options.command and options.command[0] == "--":
        options.command = options.command[1:]
    if not options.command:
        parser.error("a product command is required after --")
    if options.timeout <= 0 or options.timeout > 300:
        parser.error("--timeout must be greater than 0 and at most 300 seconds")
    if (
        options.discovery_prefix_length is not None
        and (
            options.discovery_prefix_length < 1
            or options.discovery_prefix_length > len(options.command)
        )
    ):
        parser.error("--discovery-prefix-length must select part of the product command")
    return options


def reader(stream: Any, output: queue.Queue[Any]) -> None:
    try:
        for line in stream:
            if line.strip():
                output.put(json.loads(line))
    except BaseException as error:  # Surface decoder and JSON failures to the main thread.
        output.put(error)
    finally:
        output.put(END_OF_STREAM)


def stderr_reader(stream: Any, chunks: list[str]) -> None:
    for chunk in stream:
        chunks.append(chunk)


def wait_for(
    messages: list[dict[str, Any]],
    incoming: queue.Queue[Any],
    predicate: Callable[[dict[str, Any]], bool],
    label: str,
    deadline: float,
) -> dict[str, Any]:
    for message in messages:
        if predicate(message):
            return message
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"timed out waiting for {label}")
        item = incoming.get(timeout=remaining)
        if item is END_OF_STREAM:
            raise RuntimeError(f"stdout closed before {label}")
        if isinstance(item, BaseException):
            raise item
        messages.append(item)
        if predicate(item):
            return item


def send(process: subprocess.Popen[str], value: dict[str, Any]) -> None:
    if process.stdin is None:
        raise RuntimeError("product stdin is unavailable")
    process.stdin.write(json.dumps(value, separators=(",", ":")) + "\n")
    process.stdin.flush()


def string_list(value: Any, label: str) -> list[str]:
    if (
        not isinstance(value, list)
        or any(not isinstance(item, str) or not item for item in value)
        or len(set(value)) != len(value)
    ):
        raise RuntimeError(f"{label} must contain unique non-empty strings")
    return value


def resolve_json_pointer(value: Any, pointer: str, label: str) -> Any:
    if not isinstance(pointer, str) or not pointer.startswith("#/"):
        raise RuntimeError(f"{label} contractRef is invalid")
    current = value
    for encoded in pointer[2:].split("/"):
        key = encoded.replace("~1", "/").replace("~0", "~")
        if not isinstance(current, dict) or key not in current:
            raise RuntimeError(f"{label} contractRef does not resolve")
        current = current[key]
    return current


def validate_catalog(descriptor: dict[str, Any]) -> dict[str, Any]:
    catalog = descriptor.get("operationCatalog")
    if not isinstance(catalog, dict):
        raise RuntimeError("offline discovery does not include the common operation catalog")
    product = descriptor.get("product", {})
    protocols = descriptor.get("protocols", {})
    command = catalog.get("command", {})
    if (
        catalog.get("schema") != CATALOG_SCHEMA
        or catalog.get("package") != product.get("package")
        or catalog.get("productProtocol") != protocols.get("product")
        or catalog.get("agentProtocol") != protocols.get("agent")
        or command.get("operationField") != "op"
        or command.get("argumentsField") != "args"
    ):
        raise RuntimeError("offline operation catalog identity or envelope is invalid")
    metadata = (
        descriptor.get("capabilities", {})
        .get("agentInterop", {})
        .get("operationCatalog")
    )
    contract_metadata = (
        descriptor.get("contract", {})
        .get("agentInterop", {})
        .get("operationCatalog")
    )
    if (
        not isinstance(metadata, dict)
        or metadata != contract_metadata
        or metadata.get("schema") != CATALOG_SCHEMA
        or metadata.get("discovery") != "--describe"
        or metadata.get("resource") != "references/agent-operations.json"
        or metadata.get("descriptorField") != "operationCatalog"
        or metadata.get("operationListField") != "capabilities.operations.jsonl"
    ):
        raise RuntimeError("offline operation catalog discovery metadata is inconsistent")
    operations = catalog.get("operations")
    if not isinstance(operations, list) or not operations:
        raise RuntimeError("offline operation catalog operations are invalid")
    names: list[str] = []
    by_name: dict[str, dict[str, Any]] = {}
    contract = descriptor.get("contract")
    for index, entry in enumerate(operations):
        label = f"operation[{index}]"
        if not isinstance(entry, dict):
            raise RuntimeError(f"{label} must be an object")
        operation = entry.get("op")
        if not isinstance(operation, str) or not operation:
            raise RuntimeError(f"{label}.op is invalid")
        if entry.get("kind") not in {"lifecycle", "product", "control"}:
            raise RuntimeError(f"{label}.kind is invalid")
        effects = string_list(entry.get("effects"), f"{label}.effects")
        if any(effect not in CATALOG_EFFECTS for effect in effects):
            raise RuntimeError(f"{label}.effects contains an unknown value")
        string_list(entry.get("requires"), f"{label}.requires")
        arguments = entry.get("args")
        if not isinstance(arguments, dict):
            raise RuntimeError(f"{label}.args is invalid")
        required = string_list(arguments.get("required"), f"{label}.args.required")
        optional = string_list(arguments.get("optional"), f"{label}.args.optional")
        documented = set(required + optional)
        if set(required).intersection(optional) or documented.intersection({"id", "op", "args"}):
            raise RuntimeError(f"{label}.args fields overlap or are reserved")
        groups = arguments.get("requiredAnyOf", [])
        if not isinstance(groups, list):
            raise RuntimeError(f"{label}.args.requiredAnyOf is invalid")
        for group_index, group in enumerate(groups):
            values = string_list(group, f"{label}.args.requiredAnyOf[{group_index}]")
            if not values or any(field not in documented for field in values):
                raise RuntimeError(f"{label}.args.requiredAnyOf is empty or undocumented")
        resolve_json_pointer(contract, entry.get("contractRef"), label)
        names.append(operation)
        by_name[operation] = entry
    advertised = descriptor.get("capabilities", {}).get("operations", {}).get("jsonl")
    if names != advertised or len(set(names)) != len(names):
        raise RuntimeError("offline operation catalog does not match advertised JSONL operations")
    probe = catalog.get("safeProbe")
    if not isinstance(probe, dict) or probe.get("op") not in by_name:
        raise RuntimeError("offline operation catalog safeProbe is invalid")
    probe_operation = by_name[probe["op"]]
    probe_args = probe.get("args")
    probe_effects = string_list(probe.get("effects"), "safeProbe.effects")
    probe_requires = string_list(probe.get("requires"), "safeProbe.requires")
    if (
        not isinstance(probe_args, dict)
        or any(effect not in CATALOG_EFFECTS for effect in probe_effects)
        or UNSAFE_PROBE_EFFECTS.intersection(probe_effects)
        or any(requirement not in probe_operation["requires"] for requirement in probe_requires)
    ):
        raise RuntimeError("offline operation catalog safeProbe is invalid or mutating")
    probe_fields = set(probe_args)
    required = set(probe_operation["args"]["required"])
    optional = set(probe_operation["args"]["optional"])
    if (
        not required.issubset(probe_fields)
        or not probe_fields.issubset(required.union(optional))
        or any(
            not probe_fields.intersection(group)
            for group in probe_operation["args"].get("requiredAnyOf", [])
        )
    ):
        raise RuntimeError("offline operation catalog safeProbe args are invalid")
    return catalog


def descriptor_identity(
    descriptor: dict[str, Any],
    options: argparse.Namespace,
) -> tuple[str, str, str, dict[str, Any]]:
    product = descriptor.get("product")
    profile = descriptor.get("capabilities", {}).get("agentInterop")
    if not isinstance(product, dict) or not isinstance(profile, dict):
        raise RuntimeError("offline descriptor is missing product or Agent interop identity")
    values = {
        "name": product.get("name"),
        "startup": profile.get("startupEvent"),
        "stopped": profile.get("stoppedEvent"),
    }
    for field, value in values.items():
        if not isinstance(value, str) or not value:
            raise RuntimeError(f"offline descriptor {field} identity is invalid")
        expected = getattr(options, field)
        if expected is not None and expected != value:
            raise RuntimeError(
                f"asserted {field} '{expected}' does not match offline descriptor '{value}'"
            )
    return values["name"], values["startup"], values["stopped"], profile


def discover(options: argparse.Namespace) -> dict[str, Any]:
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
    completed = subprocess.run(
        [*options.command[:prefix_length], "--describe"],
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
            f"offline discovery failed with exit {completed.returncode}: "
            f"{completed.stderr[-4096:]}"
        )
    descriptor = json.loads(lines[0])
    if descriptor.get("schema") != "npc-agent-cli-descriptor/1":
        raise RuntimeError("offline discovery returned an incompatible descriptor")
    discovery = descriptor.get("discovery", {})
    if any(
        discovery.get(field) is not False
        for field in [
            "consumesStdin",
            "startsListener",
            "startsPlatformWorker",
            "filesystemWrites",
            "inputSideEffect",
        ]
    ):
        raise RuntimeError("offline discovery does not advertise a zero-start side-effect boundary")
    validate_catalog(descriptor)
    return descriptor


def run(options: argparse.Namespace) -> dict[str, Any]:
    descriptor = discover(options)
    catalog = descriptor["operationCatalog"]
    probe = catalog["safeProbe"]
    name, startup_event, stopped_event, offline_profile = descriptor_identity(
        descriptor,
        options,
    )
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
    threading.Thread(target=reader, args=(process.stdout, incoming), daemon=True).start()
    threading.Thread(
        target=stderr_reader,
        args=(process.stderr, stderr_chunks),
        daemon=True,
    ).start()
    messages: list[dict[str, Any]] = []
    deadline = time.monotonic() + options.timeout
    try:
        startup = wait_for(
            messages,
            incoming,
            lambda message: message.get("event") == startup_event,
            "startup event",
            deadline,
        )
        profile = startup.get("capabilities", {}).get("agentInterop", {})
        if profile != offline_profile:
            raise RuntimeError("startup Agent interop profile differs from offline discovery")
        if profile.get("protocol") != "npc-agent-jsonl/1":
            raise RuntimeError("startup capabilities do not advertise npc-agent-jsonl/1")
        if profile.get("lifecycleOperations") != LIFECYCLE_OPERATIONS:
            raise RuntimeError("startup capabilities advertise an incompatible lifecycle")
        if profile.get("commandFields", {}).get("arguments") != "args":
            raise RuntimeError("startup capabilities do not advertise the common args envelope")
        if profile.get("operationCatalog", {}).get("schema") != CATALOG_SCHEMA:
            raise RuntimeError("startup capabilities do not point to the operation catalog")

        send(process, {"id": "probe", "op": probe["op"], "args": probe["args"]})
        send(process, {"id": "caps", "op": "capabilities", "args": {}})
        send(process, {"id": "status", "op": "status", "args": {}})
        send(process, {"id": "barrier", "op": "drain", "args": {}})
        for command_id in ["probe", "caps", "status", "barrier"]:
            result = wait_for(
                messages,
                incoming,
                lambda message, wanted=command_id: (
                    message.get("type") == "result" and message.get("id") == wanted
                ),
                f"{command_id} result",
                deadline,
            )
            if result.get("ok") is not True:
                raise RuntimeError(f"{command_id} failed: {result!r}")

        send(process, {"id": "stop", "op": "shutdown", "args": {}})
        if process.stdin is not None:
            process.stdin.close()
        stopped_result = wait_for(
            messages,
            incoming,
            lambda message: message.get("type") == "result" and message.get("id") == "stop",
            "shutdown result",
            deadline,
        )
        if stopped_result.get("ok") is not True:
            raise RuntimeError(f"shutdown failed: {stopped_result!r}")
        wait_for(
            messages,
            incoming,
            lambda message: message.get("event") == stopped_event,
            "stopped event",
            deadline,
        )
        code = process.wait(timeout=max(0.1, deadline - time.monotonic()))
        if code != 0:
            raise RuntimeError(
                f"product exited {code}: {''.join(stderr_chunks)[-4096:]}"
            )
        capabilities = next(
            message["value"]
            for message in messages
            if message.get("type") == "result" and message.get("id") == "caps"
        )
        if capabilities.get("agentInterop") != profile:
            raise RuntimeError("startup and command capability profiles differ")
        return {
            "schema": "npc-agent-jsonl-conformance/1",
            "name": name,
            "identitySource": "offline-descriptor",
            "protocol": profile["protocol"],
            "startup": startup_event,
            "stopped": stopped_event,
            "catalog": catalog["schema"],
            "operationCount": len(catalog["operations"]),
            "safeProbe": probe["op"],
            "messages": len(messages),
            "exitCode": code,
        }
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)


def main() -> int:
    options = arguments()
    try:
        print(json.dumps(run(options), ensure_ascii=False, separators=(",", ":")))
        return 0
    except BaseException as error:
        label = options.name or "Agent CLI"
        print(f"{label} conformance failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
