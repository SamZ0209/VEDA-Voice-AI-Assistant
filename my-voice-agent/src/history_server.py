
import json
import logging
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from database import (
    approve_memory_suggestion,
    delete_memory,
    dismiss_memory_suggestion,
    get_conversation_messages,
    get_memories,
    get_memory_suggestions,
    get_recent_conversations,
    initialize_database,
    update_saved_memory,
)

HOST = "127.0.0.1"
PORT = 8766

# Only permit the local desktop frontend.
ALLOWED_ORIGINS = {
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "tauri://localhost",
}

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("veda.history")


class HistoryHandler(BaseHTTPRequestHandler):

    def send_json(self, status, body):
        payload = json.dumps(body).encode("utf-8")

        self.send_response(status)

        origin = self.headers.get("Origin")

        if origin in ALLOWED_ORIGINS:
            self.send_header(
                "Access-Control-Allow-Origin",
                origin,
            )
            self.send_header("Vary", "Origin")

        self.send_header(
            "Content-Type",
            "application/json; charset=utf-8",
        )
        self.send_header(
            "Content-Length",
            str(len(payload)),
        )
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(payload)

    
    def do_OPTIONS(self):
        origin = self.headers.get("Origin")

        if origin not in ALLOWED_ORIGINS:
            self.send_json(
                403,
                {"error": "Origin not permitted"},
            )
            return

        self.send_response(204)

        self.send_header(
            "Access-Control-Allow-Origin",
            origin,
        )

        self.send_header(
            "Access-Control-Allow-Methods",
            "GET, POST, PATCH, DELETE, OPTIONS",
        )

        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type",
        )

        self.send_header(
            "Access-Control-Allow-Private-Network",
            "true",
        )

        self.send_header("Vary", "Origin")
        self.end_headers()


    def do_GET(self):
        origin = self.headers.get("Origin")

        if origin and origin not in ALLOWED_ORIGINS:
            self.send_json(
                403,
                {"error": "Origin not permitted"},
            )
            return

        path = urlparse(self.path).path
        
        if path == "/memory-suggestions":
            self.send_json(
                200,
                {
                    "suggestions": get_memory_suggestions(
                        "pending", 100
                    )
                },
            )
            return

        if path == "/memories":
            self.send_json(
                200,
                {
                    "memories": get_memories(100)
                },
            )
            return

        try:
            if path == "/conversations":
                conversations = get_recent_conversations(
                    limit=40
                )

                for conversation in conversations:
                    items = get_conversation_messages(
                        conversation["id"]
                    )

                    first_user = next(
                        (
                            item["content"]
                            for item in items
                            if item["role"] == "user"
                        ),
                        None,
                    )

                    conversation["preview"] = (
                        first_user[:75]
                        if first_user
                        else "No user messages yet"
                    )

                    conversation["message_count"] = len(items)

                self.send_json(
                    200,
                    {"conversations": conversations},
                )
                return

            match = re.fullmatch(
                r"/conversations/([1-9][0-9]*)/messages",
                path,
            )

            if match:
                conversation_id = int(match.group(1))

                messages = get_conversation_messages(
                    conversation_id
                )

                self.send_json(
                    200,
                    {"messages": messages},
                )
                return

            self.send_json(
                404,
                {"error": "Endpoint not found"},
            )

        except Exception:
            logger.exception("History request failed")

            self.send_json(
                500,
                {
                    "error": (
                        "Unable to read conversation history"
                    )
                },
            )
        
    def check_request_origin(self):
        origin = self.headers.get("Origin")

        if origin and origin not in ALLOWED_ORIGINS:
            self.send_json(
                403,
                {"error": "Origin not permitted"},
            )
            return False

        return True


    def read_json_body(self):
        content_type = self.headers.get(
            "Content-Type", ""
        ).split(";")[0].strip()

        if content_type != "application/json":
            raise ValueError(
                "Content-Type must be application/json"
            )

        length = int(
            self.headers.get("Content-Length", "0")
        )

        if length < 0 or length > 8192:
            raise ValueError("Request body too large")

        data = (
            self.rfile.read(length)
            if length
            else b"{}"
        )

        value = json.loads(data)

        if not isinstance(value, dict):
            raise ValueError(
                "JSON body must be an object"
            )

        return value


    def do_POST(self):
        if not self.check_request_origin():
            return

        match = re.fullmatch(
            r"/memory-suggestions/([1-9][0-9]*)/"
            r"(approve|dismiss)",
            urlparse(self.path).path,
        )

        if not match:
            self.send_json(
                404,
                {"error": "Endpoint not found"},
            )
            return

        try:
            self.read_json_body()

            suggestion_id = int(match.group(1))
            action = match.group(2)

            if action == "approve":
                memory_id = approve_memory_suggestion(
                    suggestion_id
                )

                if memory_id is None:
                    self.send_json(
                        409,
                        {"error": "Suggestion not pending"},
                    )
                else:
                    self.send_json(
                        200,
                        {
                            "ok": True,
                            "memory_id": memory_id,
                        },
                    )

            else:
                dismissed = dismiss_memory_suggestion(
                    suggestion_id
                )

                self.send_json(
                    200 if dismissed else 409,
                    {"ok": dismissed},
                )

        except (ValueError, TypeError) as exc:
            self.send_json(
                400,
                {"error": str(exc)},
            )
        except Exception:
            logger.exception(
                "Memory suggestion action failed"
            )
            self.send_json(
                500,
                {"error": "Unable to process suggestion"},
            )


    def do_PATCH(self):
        if not self.check_request_origin():
            return

        match = re.fullmatch(
            r"/memories/([1-9][0-9]*)",
            urlparse(self.path).path,
        )

        if not match:
            self.send_json(
                404,
                {"error": "Endpoint not found"},
            )
            return

        try:
            body = self.read_json_body()

            updated = update_saved_memory(
                int(match.group(1)),
                body.get("category"),
                body.get("content"),
            )

            self.send_json(
                200 if updated else 404,
                {"ok": updated},
            )

        except (ValueError, TypeError) as exc:
            self.send_json(
                400,
                {"error": str(exc)},
            )
        except Exception:
            logger.exception(
                "Memory update failed"
            )
            self.send_json(
                500,
                {"error": "Unable to update memory"},
            )


    def do_DELETE(self):
        if not self.check_request_origin():
            return

        match = re.fullmatch(
            r"/memories/([1-9][0-9]*)",
            urlparse(self.path).path,
        )

        if not match:
            self.send_json(
                404,
                {"error": "Endpoint not found"},
            )
            return

        try:
            deleted = delete_memory(
                int(match.group(1))
            )

            self.send_json(
                200 if deleted else 404,
                {"ok": deleted},
            )

        except Exception:
            logger.exception(
                "Memory deletion failed"
            )

            self.send_json(
                500,
                {"error": "Unable to delete memory"},
            )



if __name__ == "__main__":
    initialize_database()

    server = ThreadingHTTPServer(
        (HOST, PORT),
        HistoryHandler,
    )

    logger.info(
        "V.E.D.A. history API listening at "
        "http://%s:%s",
        HOST,
        PORT,
    )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
