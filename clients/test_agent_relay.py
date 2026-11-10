import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from clients.agent_relay import AgentRelayClient, ApprovalRequired


class FakeRelayHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    @property
    def state(self):
        return self.server.state

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path == "/api/health":
            return self.send_json({"ok": True})
        if self.path == "/api/status":
            return self.send_json({"ok": True, "keyConfigured": True})
        if self.path == "/v1/agents":
            return self.send_json({"agents": [{"key": "game-director"}]})
        if self.path in ("/v1/agents/game-director", "/v1/agents/game-director?refresh=true"):
            return self.send_json({"agent": {"key": "game-director", "sessionId": "session-1"}})
        if self.path == "/v1/agents/game-director/events":
            self.state["polls"] = self.state.get("polls", 0) + 1
            if self.state.get("user_event") and self.state["polls"] >= 2 and not self.state.get("finished"):
                if self.state.get("approval_flow") and not self.state.get("confirmed"):
                    self.state["events"].extend([
                        {"id": "tool-1", "type": "agent.tool_use", "name": "bash", "input": {}, "evaluated_permission": "ask"},
                        {"id": "idle-action", "type": "session.status_idle", "stop_reason": {"type": "requires_action", "event_ids": ["tool-1"]}},
                    ])
                else:
                    self.state["events"].extend([
                        {"id": "agent-1", "type": "agent.message", "content": [{"type": "text", "text": "DONE"}]},
                        {"id": "idle-2", "type": "session.status_idle", "stop_reason": {"type": "end_turn"}},
                    ])
                self.state["finished"] = True
            return self.send_json({"sessionId": "session-1", "events": self.state["events"]})
        if self.path == "/v1/agents/game-director/session":
            return self.send_json({"session": {"id": "session-1", "status": "idle"}})
        if self.path == "/v1/agents/game-director/memories":
            return self.send_json({"memoryStoreId": "store-1", "memories": self.state["memories"]})
        return self.send_json({"error": {"message": "Not found"}}, 404)

    def do_POST(self):
        payload = self.read_json()
        if self.path == "/v1/agents/game-director/messages":
            self.state["polls"] = 0
            self.state["user_event"] = "user-new"
            self.state["events"] = [
                {"id": "idle-old", "type": "session.status_idle", "stop_reason": {"type": "end_turn"}},
                {"id": "user-new", "type": "user.message", "content": [{"type": "text", "text": payload["message"]}]},
            ]
            return self.send_json({
                "sessionId": "session-1",
                "result": {"data": [{"id": "user-new", "type": "user.message"}]},
            }, 202)
        if self.path == "/v1/agents/game-director/confirmations":
            self.state["confirmation"] = payload
            self.state["confirmed"] = payload["result"] == "allow"
            self.state["finished"] = False
            return self.send_json({"data": []})
        if self.path == "/v1/agents/game-director/stream":
            events = [
                {"type": "relay.session", "session_id": "session-1", "agent_key": "game-director"},
                {"id": "agent-stream", "type": "agent.message", "content": [{"type": "text", "text": "STREAM_OK"}]},
                {"id": "idle-stream", "type": "session.status_idle", "stop_reason": {"type": "end_turn"}},
                {"type": "relay.done"},
            ]
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(b": keepalive\n\n")
            for event in events:
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode("utf-8"))
            return
        if self.path == "/v1/agents/game-director/memories":
            memory = {"id": "mem-new", "type": "memory", **payload, "content_sha256": "new-hash"}
            self.state["memories"].append(memory)
            return self.send_json({"memory": memory}, 201)
        return self.send_json({"error": {"message": "Not found"}}, 404)

    def do_PUT(self):
        payload = self.read_json()
        if self.path.startswith("/v1/agents/game-director/memories/"):
            self.state["update"] = payload
            memory = {"id": "mem-1", "type": "memory", **payload, "content_sha256": "next-hash"}
            return self.send_json({"memory": memory})
        return self.send_json({"error": {"message": "Not found"}}, 404)


class AgentRelayClientTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeRelayHandler)
        self.server.state = {
            "events": [],
            "memories": [{
                "id": "mem-1",
                "type": "memory",
                "path": "/PROJECT.md",
                "content": "old",
                "content_sha256": "old-hash",
            }],
        }
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = AgentRelayClient(
            base_url=f"http://127.0.0.1:{self.server.server_port}",
            poll_interval=0.01,
            timeout=5,
        )

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_run_task_ignores_previous_idle_and_returns_new_reply(self):
        result = self.client.run_task("Finish the test", timeout_seconds=2)
        self.assertEqual(result.replies, ["DONE"])
        self.assertEqual(result.stop_reason, "end_turn")
        self.assertEqual(result.session_id, "session-1")
        self.assertNotEqual(result.events[0]["id"], "idle-old")

    def test_approval_is_required_by_default(self):
        self.server.state["approval_flow"] = True
        with self.assertRaises(ApprovalRequired) as context:
            self.client.run_task("Run a tool", timeout_seconds=2)
        self.assertEqual(context.exception.event["id"], "tool-1")

    def test_explicit_auto_approval_continues_turn(self):
        self.server.state["approval_flow"] = True
        result = self.client.run_task("Run an approved tool", timeout_seconds=2, auto_approve=True)
        self.assertEqual(result.replies, ["DONE"])
        self.assertEqual(self.server.state["confirmation"]["eventId"], "tool-1")
        self.assertEqual(self.server.state["confirmation"]["result"], "allow")

    def test_remember_updates_with_latest_hash(self):
        memory = self.client.remember("/PROJECT.md", "new content")
        self.assertEqual(memory["content_sha256"], "next-hash")
        self.assertEqual(self.server.state["update"]["contentSha256"], "old-hash")
        self.assertEqual(self.server.state["update"]["path"], "/PROJECT.md")

    def test_stream_parses_keepalives_and_json_events(self):
        events = self.client.stream("Stream the test")
        self.assertEqual(events[-1]["type"], "relay.done")
        self.assertEqual(events[1]["content"][0]["text"], "STREAM_OK")

    def test_recover_returns_session_events_and_memory(self):
        recovered = self.client.recover()
        self.assertEqual(recovered["session"]["id"], "session-1")
        self.assertEqual(recovered["memories"][0]["path"], "/PROJECT.md")
        self.assertIn("events", recovered)


if __name__ == "__main__":
    unittest.main()
