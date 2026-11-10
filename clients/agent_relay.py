#!/usr/bin/env python3
"""Standard-library client for the local AgentRelay API.

Library example:
    from clients.agent_relay import AgentRelayClient
    relay = AgentRelayClient(agent_key="game-director")
    result = relay.run_task("Read memory and report the next milestone.")
    print(result.replies)

CLI example:
    python clients/agent_relay.py run --message "Report project status."
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Iterable

JsonObject = dict[str, Any]
EventCallback = Callable[[JsonObject], None]
ApprovalHandler = Callable[[JsonObject], bool | str]


class AgentRelayError(RuntimeError):
    """An HTTP, protocol, or managed-turn failure."""

    def __init__(self, message: str, status: int | None = None, payload: Any = None):
        super().__init__(message)
        self.status = status
        self.payload = payload


class ApprovalRequired(AgentRelayError):
    """A tool call cannot continue without an operator decision."""

    def __init__(self, event: JsonObject):
        self.event = event
        event_id = event.get("id", "unknown")
        tool = event.get("name", event.get("type", "tool"))
        super().__init__(f"Approval required for {tool}; tool event ID: {event_id}", payload=event)


@dataclass
class TurnResult:
    session_id: str
    replies: list[str]
    events: list[JsonObject]
    stop_reason: str

    def to_dict(self) -> JsonObject:
        return {
            "sessionId": self.session_id,
            "replies": self.replies,
            "events": self.events,
            "stopReason": self.stop_reason,
        }


class AgentRelayClient:
    def __init__(
        self,
        base_url: str | None = None,
        agent_key: str | None = None,
        timeout: float = 60,
        poll_interval: float = 3,
        access_token: str | None = None,
    ):
        self.base_url = (base_url or os.getenv("AGENT_RELAY_URL") or "http://127.0.0.1:7100").rstrip("/")
        self.agent_key = agent_key or os.getenv("AGENT_RELAY_KEY") or "game-director"
        self.access_token = access_token or os.getenv("AGENT_RELAY_ACCESS_TOKEN") or ""
        self.timeout = timeout
        self.poll_interval = poll_interval

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def _agent_path(self, suffix: str = "", key: str | None = None) -> str:
        agent_key = urllib.parse.quote(key or self.agent_key, safe="")
        return f"/v1/agents/{agent_key}{suffix}"

    def _headers(self, accept: str) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": accept}
        if self.access_token:
            headers["Authorization"] = f"Bearer {self.access_token}"
        return headers

    @staticmethod
    def _decode_response(response: Any) -> Any:
        raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}

    @staticmethod
    def _error_message(payload: Any, fallback: str) -> str:
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict) and error.get("message"):
                return str(error["message"])
            if payload.get("message"):
                return str(payload["message"])
        return fallback

    def _request(self, path: str, method: str = "GET", payload: Any = None) -> Any:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self._url(path),
            data=body,
            method=method,
            headers=self._headers("application/json"),
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return self._decode_response(response)
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read().decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                payload = None
            raise AgentRelayError(
                self._error_message(payload, f"AgentRelay returned HTTP {error.code}"),
                status=error.code,
                payload=payload,
            ) from error
        except urllib.error.URLError as error:
            raise AgentRelayError(f"Cannot reach AgentRelay at {self.base_url}: {error.reason}") from error

    def health(self) -> JsonObject:
        return self._request("/api/health")

    def status(self) -> JsonObject:
        return self._request("/api/status")

    def list_agents(self) -> list[JsonObject]:
        return self._request("/v1/agents")["agents"]

    def get_agent(self, refresh: bool = False, key: str | None = None) -> JsonObject:
        query = "?refresh=true" if refresh else ""
        return self._request(self._agent_path(query, key))["agent"]

    def create_agent(self, **fields: Any) -> JsonObject:
        return self._request("/v1/agents", "POST", fields)["agent"]

    def get_session(self, key: str | None = None) -> JsonObject:
        return self._request(self._agent_path("/session", key))["session"]

    def get_events(self, key: str | None = None) -> list[JsonObject]:
        return self._request(self._agent_path("/events", key))["events"]

    def send(self, message: str, key: str | None = None) -> JsonObject:
        if not message or not message.strip():
            raise ValueError("message cannot be empty")
        return self._request(self._agent_path("/messages", key), "POST", {"message": message})

    def interrupt(self, key: str | None = None) -> JsonObject:
        return self._request(self._agent_path("/interrupt", key), "POST")

    def confirm(
        self,
        event_id: str,
        allow: bool,
        message: str | None = None,
        key: str | None = None,
    ) -> JsonObject:
        payload: JsonObject = {"eventId": event_id, "result": "allow" if allow else "deny"}
        if not allow and message:
            payload["message"] = message
        return self._request(self._agent_path("/confirmations", key), "POST", payload)

    def reset(self, key: str | None = None) -> JsonObject:
        return self._request(self._agent_path("/reset", key), "POST")

    def list_memories(self, key: str | None = None) -> list[JsonObject]:
        return self._request(self._agent_path("/memories", key))["memories"]

    def create_memory(self, path: str, content: str, key: str | None = None) -> JsonObject:
        return self._request(self._agent_path("/memories", key), "POST", {"path": path, "content": content})["memory"]

    def update_memory(
        self,
        memory_id: str,
        content: str,
        path: str | None = None,
        content_sha256: str | None = None,
        key: str | None = None,
    ) -> JsonObject:
        payload: JsonObject = {"content": content}
        if path is not None:
            payload["path"] = path
        if content_sha256:
            payload["contentSha256"] = content_sha256
        memory_id = urllib.parse.quote(memory_id, safe="")
        return self._request(self._agent_path(f"/memories/{memory_id}", key), "PUT", payload)["memory"]

    def delete_memory(self, memory_id: str, key: str | None = None) -> JsonObject:
        memory_id = urllib.parse.quote(memory_id, safe="")
        return self._request(self._agent_path(f"/memories/{memory_id}", key), "DELETE")

    def remember(self, path: str, content: str, key: str | None = None) -> JsonObject:
        """Create or safely update a memory using the latest content hash."""
        for attempt in range(2):
            existing = next((memory for memory in self.list_memories(key) if memory.get("path") == path), None)
            try:
                if existing is None:
                    return self.create_memory(path, content, key)
                return self.update_memory(
                    existing["id"],
                    content,
                    path=path,
                    content_sha256=existing.get("content_sha256"),
                    key=key,
                )
            except AgentRelayError as error:
                if error.status != 409 or attempt == 1:
                    raise
        raise AssertionError("unreachable")

    def recover(self, key: str | None = None) -> JsonObject:
        """Recover everything needed to resume after a process or client restart."""
        return {
            "agent": self.get_agent(refresh=True, key=key),
            "session": self.get_session(key),
            "events": self.get_events(key),
            "memories": self.list_memories(key),
        }

    def _resolve_approval(
        self,
        event: JsonObject,
        auto_approve: bool,
        approval_handler: ApprovalHandler | None,
        key: str | None,
    ) -> None:
        decision: bool | str | None = None
        if approval_handler:
            decision = approval_handler(event)
        elif auto_approve:
            decision = True
        if decision is True or decision == "allow":
            self.confirm(event["id"], True, key=key)
        elif decision is False or decision == "deny":
            self.confirm(event["id"], False, message="Denied by the client approval policy.", key=key)
        else:
            raise ApprovalRequired(event)

    @staticmethod
    def _sse_events(response: Any) -> Iterable[JsonObject]:
        buffer = b""
        for chunk in response:
            buffer += chunk.replace(b"\r\n", b"\n")
            while b"\n\n" in buffer:
                raw, buffer = buffer.split(b"\n\n", 1)
                data = b"\n".join(line[6:] for line in raw.split(b"\n") if line.startswith(b"data: "))
                if data:
                    yield json.loads(data.decode("utf-8"))
        if buffer.strip():
            data = b"\n".join(line[6:] for line in buffer.split(b"\n") if line.startswith(b"data: "))
            if data:
                yield json.loads(data.decode("utf-8"))

    def stream(
        self,
        message: str,
        on_event: EventCallback | None = None,
        auto_approve: bool = False,
        approval_handler: ApprovalHandler | None = None,
        key: str | None = None,
    ) -> list[JsonObject]:
        """Send a message and yield control to a callback for every streamed event."""
        if not message or not message.strip():
            raise ValueError("message cannot be empty")
        body = json.dumps({"message": message}).encode("utf-8")
        request = urllib.request.Request(
            self._url(self._agent_path("/stream", key)),
            data=body,
            method="POST",
            headers=self._headers("text/event-stream"),
        )
        events: list[JsonObject] = []
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                for event in self._sse_events(response):
                    if event.get("type") == "relay.error":
                        raise AgentRelayError(str(event.get("message") or "AgentRelay stream failed"), payload=event)
                    events.append(event)
                    if on_event:
                        on_event(event)
                    if event.get("evaluated_permission") == "ask":
                        self._resolve_approval(event, auto_approve, approval_handler, key)
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read().decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                payload = None
            raise AgentRelayError(self._error_message(payload, f"Stream returned HTTP {error.code}"), error.code, payload) from error
        except urllib.error.URLError as error:
            raise AgentRelayError(f"AgentRelay stream failed: {error.reason}") from error
        return events

    def run_task(
        self,
        message: str,
        timeout_seconds: float = 3600,
        on_event: EventCallback | None = None,
        auto_approve: bool = False,
        approval_handler: ApprovalHandler | None = None,
        key: str | None = None,
    ) -> TurnResult:
        """Queue a message and poll until an idle event for that exact turn."""
        accepted = self.send(message, key)
        try:
            user_event_id = accepted["result"]["data"][0]["id"]
            session_id = accepted["sessionId"]
        except (KeyError, IndexError, TypeError) as error:
            raise AgentRelayError("Unexpected message acceptance response", payload=accepted) from error

        seen: set[str] = set()
        approved: set[str] = set()
        turn_events: list[JsonObject] = []
        replies: list[str] = []
        deadline = time.monotonic() + timeout_seconds

        while time.monotonic() < deadline:
            events = self.get_events(key)
            try:
                start = next(index for index, event in enumerate(events) if event.get("id") == user_event_id)
            except StopIteration:
                time.sleep(self.poll_interval)
                continue

            for event in events[start:]:
                event_id = event.get("id")
                if event_id and event_id in seen:
                    continue
                if event_id:
                    seen.add(event_id)
                turn_events.append(event)
                if on_event:
                    on_event(event)

                kind = event.get("type")
                if kind == "agent.message":
                    replies.append("".join(block.get("text", "") for block in event.get("content", [])))
                elif kind in ("agent.tool_use", "agent.mcp_tool_use") and event.get("evaluated_permission") == "ask":
                    self._resolve_approval(event, auto_approve, approval_handler, key)
                    approved.add(event["id"])
                elif kind == "agent.custom_tool_use":
                    raise AgentRelayError("Custom tool execution is not registered in this relay client", payload=event)
                elif kind == "session.error":
                    raise AgentRelayError(str(event.get("error") or "Managed session error"), payload=event)
                elif kind == "session.status_idle":
                    reason = (event.get("stop_reason") or {}).get("type", "unknown")
                    if reason == "end_turn":
                        return TurnResult(session_id, replies, turn_events, reason)
                    if reason == "requires_action":
                        blocking = set((event.get("stop_reason") or {}).get("event_ids", []))
                        if blocking and blocking.issubset(approved):
                            continue
                        raise ApprovalRequired(event)
                    if reason == "budget_reached":
                        raise AgentRelayError("Session spending cap reached", payload=event)
                    raise AgentRelayError(f"Managed turn stopped: {reason}", payload=event)

            time.sleep(self.poll_interval)

        raise TimeoutError(f"Managed-agent turn did not finish within {timeout_seconds} seconds")


def _print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Use a sticky agent through local AgentRelay.")
    parser.add_argument("--base-url", default=os.getenv("AGENT_RELAY_URL", "http://127.0.0.1:7100"))
    parser.add_argument("--key", default=os.getenv("AGENT_RELAY_KEY", "game-director"))
    parser.add_argument("--access-token", default=os.getenv("AGENT_RELAY_ACCESS_TOKEN", ""))
    parser.add_argument("--timeout", type=float, default=60, help="Individual HTTP/socket timeout in seconds")
    parser.add_argument("--poll-interval", type=float, default=3)
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("status")
    commands.add_parser("agents")
    commands.add_parser("recover")
    commands.add_parser("events")
    commands.add_parser("memories")
    commands.add_parser("interrupt")

    for name in ("run", "stream"):
        command = commands.add_parser(name)
        command.add_argument("--message", required=True)
        command.add_argument("--auto-approve", action="store_true", help="Explicitly allow every approval-requested tool")
        if name == "run":
            command.add_argument("--timeout-seconds", type=float, default=3600)

    remember = commands.add_parser("remember")
    remember.add_argument("--path", required=True)
    source = remember.add_mutually_exclusive_group(required=True)
    source.add_argument("--content")
    source.add_argument("--content-file")

    reset = commands.add_parser("reset")
    reset.add_argument("--yes", action="store_true", required=True, help="Confirm that the current conversation may be archived")

    confirm = commands.add_parser("confirm")
    confirm.add_argument("--event-id", required=True)
    decision = confirm.add_mutually_exclusive_group(required=True)
    decision.add_argument("--allow", action="store_true")
    decision.add_argument("--deny", action="store_true")
    confirm.add_argument("--message")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    client = AgentRelayClient(args.base_url, args.key, args.timeout, args.poll_interval, args.access_token)
    try:
        if args.command == "status":
            _print_json({"health": client.health(), "status": client.status()})
        elif args.command == "agents":
            _print_json(client.list_agents())
        elif args.command == "recover":
            _print_json(client.recover())
        elif args.command == "events":
            _print_json(client.get_events())
        elif args.command == "memories":
            _print_json(client.list_memories())
        elif args.command == "interrupt":
            _print_json(client.interrupt())
        elif args.command == "reset":
            _print_json(client.reset())
        elif args.command == "confirm":
            _print_json(client.confirm(args.event_id, args.allow, args.message))
        elif args.command == "remember":
            content = args.content
            if args.content_file:
                with open(args.content_file, encoding="utf-8") as handle:
                    content = handle.read()
            _print_json(client.remember(args.path, content or ""))
        elif args.command == "stream":
            client.stream(args.message, on_event=lambda event: print(json.dumps(event, ensure_ascii=False), flush=True), auto_approve=args.auto_approve)
        elif args.command == "run":
            result = client.run_task(args.message, timeout_seconds=args.timeout_seconds, auto_approve=args.auto_approve)
            _print_json(result.to_dict())
        return 0
    except (AgentRelayError, TimeoutError, ValueError, OSError) as error:
        print(json.dumps({"error": str(error), "type": type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
