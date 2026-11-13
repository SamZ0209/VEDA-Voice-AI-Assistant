
import json
import os
import traceback
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv
from livekit import api

PROJECT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_DIR / ".env")

LIVEKIT_URL = os.getenv("LIVEKIT_URL", "ws://localhost:7880")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET")

HOST = "127.0.0.1"
PORT = 8765
AGENT_NAME = "my-voice-agent"

if not LIVEKIT_API_KEY or not LIVEKIT_API_SECRET:
    raise RuntimeError(
        "LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set in .env"
    )


class TokenHandler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_json(200, {"ok": True})

    def do_POST(self):
        if self.path != "/token":
            self.send_json(404, {"error": "Not found"})
            return

        try:
            room_name = f"veda-{uuid4().hex[:12]}"
            identity = f"veda-desktop-{uuid4().hex[:8]}"

            token = (
                api.AccessToken(
                    LIVEKIT_API_KEY,
                    LIVEKIT_API_SECRET,
                )
                .with_identity(identity)
                .with_grants(
                    api.VideoGrants(
                        room_join=True,
                        room=room_name,
                        can_publish=True,
                        can_subscribe=True,
                    )
                )
                .with_room_config(
                    api.RoomConfiguration(
                        agents=[
                            api.RoomAgentDispatch(
                                agent_name=AGENT_NAME,
                            )
                        ],
                    )
                )
                .with_ttl(timedelta(minutes=10))
                .to_jwt()
            )

            self.send_json(
                200,
                {
                    "serverUrl": LIVEKIT_URL,
                    "participantToken": token,
                    "room": room_name,
                },
            )
        except Exception as e:
            print("[token-server] Token generation failed:")
            traceback.print_exc()
            self.send_json(500, {
                "error": "Token generation failed",
                "details": str(e)
            })

    def log_message(self, format, *args):
        print(f"[token-server] {format % args}")


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), TokenHandler)
    print(f"V.E.D.A. token server listening on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
