import sqlite3
from pathlib import Path

# Locate the main ai_assistant directory
PROJECT_DIR = Path(__file__).resolve().parents[2]

# Database location
DATABASE_PATH = PROJECT_DIR / "data" / "veda_memory.db"


def get_connection():
    """Create a connection to the V.E.D.A. database."""

    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database():
    """Initialize the database and create tables if needed."""
    with get_connection() as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_name TEXT NOT NULL UNIQUE,
                started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                ended_at DATETIME
            )
        """)

        connection.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                role TEXT NOT NULL CHECK (
                    role IN ('user', 'assistant', 'system')
                ),
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

                FOREIGN KEY (conversation_id)
                    REFERENCES conversations(id)
                    ON DELETE CASCADE
            )
        """)

        connection.execute("""
            CREATE INDEX IF NOT EXISTS idx_messages_conversation
            ON messages(conversation_id)
        """)
        connection.execute("""
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)

        connection.execute("""
            CREATE INDEX IF NOT EXISTS idx_memories_category
            ON memories(category)
        """)
        initialize_memory_suggestions()
        # connection.execute("""
        #     CREATE TABLE IF NOT EXISTS memory_suggestions (
        #         id INTEGER PRIMARY KEY AUTOINCREMENT,
        #         conversation_id INTEGER,
        #         category TEXT NOT NULL,
        #         content TEXT NOT NULL,
        #         status TEXT NOT NULL DEFAULT 'pending'
        #             CHECK(status IN ('pending', 'approved', 'dismissed')),
        #         memory_id INTEGER,
        #         created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        #         resolved_at DATETIME,
        #         FOREIGN KEY (conversation_id)
        #             REFERENCES conversations(id) ON DELETE SET NULL,
        #         FOREIGN KEY (memory_id)
        #             REFERENCES memories(id) ON DELETE SET NULL
        #     )
        # """)


def create_conversation(room_name):
    """Create a new conversation and return its database ID."""
    with get_connection() as connection:
        cursor = connection.execute(
            "INSERT INTO conversations (room_name) VALUES (?)", (room_name,)
        )
        return cursor.lastrowid


def save_message(conversation_id, role, content):
    """Save a user or assistant message."""
    if role not in ("user", "assistant", "system"):
        raise ValueError(f"Invalid message role: {role}")

    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO messages (conversation_id, role, content)
            VALUES (?, ?, ?)
            """,
            (conversation_id, role, content),
        )


def end_conversation(conversation_id):
    """Record when a conversation ends."""
    with get_connection() as connection:
        connection.execute(
            """
            UPDATE conversations
            SET ended_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (conversation_id,),
        )


def get_conversation_messages(conversation_id):
    """Retrieve all messages from a conversation."""
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT role, content, created_at
            FROM messages
            WHERE conversation_id = ?
            ORDER BY id ASC
            """,
            (conversation_id,),
        ).fetchall()

        return [dict(row) for row in rows]


def get_recent_conversations(limit=10):
    """Retrieve the most recent conversations."""
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, room_name, started_at, ended_at
            FROM conversations
            ORDER BY started_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

        return [dict(row) for row in rows]


def save_memory(category, content):
    """Save an important piece of long-term memory."""
    if not category.strip() or not content.strip():
        raise ValueError("Memory category and content cannot be empty.")

    with get_connection() as connection:
        cursor = connection.execute(
            """
            INSERT INTO memories (category, content)
            VALUES (?, ?)
            """,
            (category.strip(), content.strip()),
        )

        return cursor.lastrowid


def get_memories(limit=30):
    """Retrieve saved long-term memories."""
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, category, content, created_at, updated_at
            FROM memories
            ORDER BY updated_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

        return [dict(row) for row in rows]


def delete_memory(memory_id):
    """Delete a specific long-term memory."""
    with get_connection() as connection:
        cursor = connection.execute("DELETE FROM memories WHERE id = ?", (memory_id,))

        return cursor.rowcount > 0


VALID_MEMORY_CATEGORIES = {
    "project",
    "preference",
    "goal",
    "workflow",
    "personal_context",
    "other",
}


def _memory_text(value, field, limit):
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")

    value = " ".join(value.split()).strip()

    if not value or len(value) > limit:
        raise ValueError(
            f"{field} must contain 1-{limit} characters"
        )

    return value


def _memory_category(category):
    category = _memory_text(
        category, "category", 30
    ).lower()

    if category not in VALID_MEMORY_CATEGORIES:
        raise ValueError("Unknown memory category")

    return category


def initialize_memory_suggestions():
    with get_connection() as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS memory_suggestions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER,
                category TEXT NOT NULL,
                content TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN (
                        'pending', 'approved', 'dismissed'
                    )),
                memory_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                resolved_at DATETIME,
                FOREIGN KEY (conversation_id)
                    REFERENCES conversations(id)
                    ON DELETE SET NULL,
                FOREIGN KEY (memory_id)
                    REFERENCES memories(id)
                    ON DELETE SET NULL
            )
        """)

        connection.execute("""
            CREATE INDEX IF NOT EXISTS
                idx_memory_suggestions_status
            ON memory_suggestions(status, id DESC)
        """)


def propose_memory(category, content, conversation_id=None):
    category = _memory_category(category)
    content = _memory_text(content, "memory", 300)
    normalized = content.casefold()

    with get_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")

        existing = connection.execute(
            "SELECT content FROM memories"
        ).fetchall()

        previous = connection.execute("""
            SELECT content FROM memory_suggestions
            WHERE status IN ('pending', 'dismissed')
        """).fetchall()

        # Avoid exact normalized duplicates.
        if any(
            " ".join(row["content"].split()).casefold()
            == normalized
            for row in (*existing, *previous)
        ):
            return None

        cursor = connection.execute("""
            INSERT INTO memory_suggestions (
                conversation_id, category, content
            )
            VALUES (?, ?, ?)
        """, (conversation_id, category, content))

        row = connection.execute("""
            SELECT id, conversation_id, category,
                   content, status, created_at
            FROM memory_suggestions
            WHERE id = ?
        """, (cursor.lastrowid,)).fetchone()

        return dict(row)


def get_memory_suggestions(status="pending", limit=100):
    if status not in (
        "pending", "approved", "dismissed"
    ):
        raise ValueError("Invalid suggestion status")

    limit = min(max(int(limit), 1), 200)

    with get_connection() as connection:
        rows = connection.execute("""
            SELECT id, conversation_id, category,
                   content, status, memory_id,
                   created_at, resolved_at
            FROM memory_suggestions
            WHERE status = ?
            ORDER BY id DESC
            LIMIT ?
        """, (status, limit)).fetchall()

        return [dict(row) for row in rows]


def approve_memory_suggestion(suggestion_id):
    with get_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")

        row = connection.execute("""
            SELECT category, content
            FROM memory_suggestions
            WHERE id = ? AND status = 'pending'
        """, (suggestion_id,)).fetchone()

        if row is None:
            return None

        memories = connection.execute("""
            SELECT id, content FROM memories
        """).fetchall()

        normalized = (
            " ".join(row["content"].split()).casefold()
        )

        existing = next(
            (
                memory for memory in memories
                if " ".join(
                    memory["content"].split()
                ).casefold() == normalized
            ),
            None,
        )

        if existing:
            memory_id = existing["id"]
        else:
            cursor = connection.execute("""
                INSERT INTO memories(category, content)
                VALUES (?, ?)
            """, (
                row["category"],
                row["content"],
            ))

            memory_id = cursor.lastrowid

        connection.execute("""
            UPDATE memory_suggestions
            SET status = 'approved',
                memory_id = ?,
                resolved_at = CURRENT_TIMESTAMP
            WHERE id = ?
        """, (memory_id, suggestion_id))

        return memory_id


def dismiss_memory_suggestion(suggestion_id):
    with get_connection() as connection:
        cursor = connection.execute("""
            UPDATE memory_suggestions
            SET status = 'dismissed',
                resolved_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND status = 'pending'
        """, (suggestion_id,))

        return cursor.rowcount > 0


def update_saved_memory(memory_id, category, content):
    category = _memory_category(category)
    content = _memory_text(content, "memory", 300)

    with get_connection() as connection:
        cursor = connection.execute("""
            UPDATE memories
            SET category = ?,
                content = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        """, (category, content, memory_id))

        return cursor.rowcount > 0
