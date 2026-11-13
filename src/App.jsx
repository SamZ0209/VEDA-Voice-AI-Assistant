
import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent } from "livekit-client";
import "./App.css";
import "./VedaChat.css";
import "./VedaMemory.css";

const CHAT_TOPIC = "veda-chat";
const HISTORY_API = "http://127.0.0.1:8766";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function App() {
  const [status, setStatus] = useState("DISCONNECTED");
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState("text");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState(null);
  const [savedMessages, setSavedMessages] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const roomRef = useRef(null);
  const modeRef = useRef("text");
  const bottomRef = useRef(null);
  const handshakeRef = useRef(null);

  const [memorySuggestions, setMemorySuggestions] = useState([]);
  const [savedMemories, setSavedMemories] = useState([]);
  const [memoryError, setMemoryError] = useState("");
  const [memoryBusy, setMemoryBusy] = useState(null);
  const [editingMemory, setEditingMemory] = useState(null);
  const [showMemoryCenter, setShowMemoryCenter] = useState(true);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: "smooth",
    });
  }, [messages, savedMessages, selectedHistoryId]);

  useEffect(() => {
    return () => {
      roomRef.current?.disconnect();

      if (handshakeRef.current) {
        clearInterval(handshakeRef.current);
      }
    };
  }, []);
  useEffect(() => {
    refreshMemoryData();

    const timer = setInterval(
      refreshMemoryData,
      15000
    );

    return () => clearInterval(timer);
  }, []);
  function cleanAudio() {
    document
      .querySelectorAll("[data-veda-audio='true']")
      .forEach((element) => element.remove());
  }
  useEffect(() => {
    refreshHistory();
  }, []);
  function setAudioMode(nextMode) {
    modeRef.current = nextMode;
    setMode(nextMode);

    document
      .querySelectorAll("[data-veda-audio='true']")
      .forEach((element) => {
        element.muted = nextMode === "text";
      });
  }

  async function switchMode(nextMode) {
    setError("");

    try {
      if (roomRef.current && connected) {
        await roomRef.current.localParticipant
          .setMicrophoneEnabled(nextMode === "voice");
      }

      setAudioMode(nextMode);
    } catch (err) {
      setError(`Could not switch mode: ${err.message}`);
    }
  }

  function startHandshake(connection) {
    // Clear any previous handshake timer.
    if (handshakeRef.current) {
      clearInterval(handshakeRef.current);
    }

    async function sendHello() {
      if (roomRef.current !== connection) {
        return;
      }

      try {
        await connection.localParticipant.publishData(
          encoder.encode(
            JSON.stringify({
              type: "hello",
            })
          ),
          {
            reliable: true,
            topic: CHAT_TOPIC,
          }
        );
      } catch (err) {
        console.warn("Handshake failed:", err);
      }
    }

    // Send immediately, then retry until acknowledged.
    sendHello();

    handshakeRef.current = setInterval(
      sendHello,
      1000
    );
  }

  function stopHandshake() {
    if (handshakeRef.current) {
      clearInterval(handshakeRef.current);
      handshakeRef.current = null;
    }
  }

  
  async function refreshMemoryData() {
    try {
      const [pending, approved] = await Promise.all([
        memoryApi("/memory-suggestions"),
        memoryApi("/memories"),
      ]);

      setMemorySuggestions(
        pending.suggestions || []
      );

      setSavedMemories(
        approved.memories || []
      );

      return true;
    } catch (err) {
      console.error(
        "[MEMORY] Refresh failed:",
        err
      );

      setMemoryError(
        `Unable to refresh memories: ${err.message}`
      );

      return false;
    }
  }

  async function refreshHistory() {
    try {
      const response = await fetch(
        `${HISTORY_API}/conversations`
      );

      if (!response.ok) {
        throw new Error(
          `History server returned HTTP ${response.status}`
        );
      }

      const data = await response.json();

      setHistory(data.conversations || []);
      setHistoryError("");
    } catch (err) {
      console.error(
        "History loading failed:",
        err
      );

      setHistoryError(
        err?.message ?? String(err)
      );
    }
  }


  async function openSavedConversation(conversationId) {
    // Close any live session before viewing old messages.
    // This also turns off the microphone.
    if (connected) {
      stopAssistant();
    }

    setSelectedHistoryId(conversationId);
    setSavedMessages([]);
    setHistoryLoading(true);
    setHistoryError("");

    try {
      const response = await fetch(
        `${HISTORY_API}/conversations/${conversationId}/messages`
      );

      if (!response.ok) {
        throw new Error(
          `Unable to load conversation: ${response.status}`
        );
      }

      const data = await response.json();

      setSavedMessages(data.messages || []);
    } catch (err) {
      console.error("Conversation loading failed:", err);
      setHistoryError(err.message);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function startNewChat() {
    if (connected) {
      stopAssistant();
    }

    setSelectedHistoryId(null);
    setSavedMessages([]);

    await startAssistant();
  }

  function formatHistoryDate(value) {
    if (!value) return "Unknown date";

    // SQLite CURRENT_TIMESTAMP is stored in UTC.
    const date = new Date(
      value.replace(" ", "T") + "Z"
    );

    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleString();
  }

  async function startAssistant() {
    setError("");
    setStatus("CONNECTING");
    setReady(false);
    setMessages([]);
    setSelectedHistoryId(null);
    setSavedMessages([]);
    try {
      // Request a fresh token and room.
      const response = await fetch(
        "http://127.0.0.1:8765/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        }
      );

      if (!response.ok) {
        throw new Error(
          `Token server returned HTTP ${response.status}`
        );
      }

      const {
        serverUrl,
        participantToken,
        room,
      } = await response.json();

      if (!serverUrl || !participantToken || !room) {
        throw new Error("Incomplete token response");
      }

      console.log("Connecting to V.E.D.A. room:", room);

      const connection = new Room();
      roomRef.current = connection;

      connection.on(RoomEvent.Disconnected, () => {
        setConnected(false);
        setReady(false);
        setStatus("DISCONNECTED");
        stopHandshake();
        cleanAudio();
      });

      // Receive text messages from the Python agent.
      connection.on(
        RoomEvent.DataReceived,
        (bytes, participant, kind, topic) => {
          if (topic !== CHAT_TOPIC) return;

          try {
            const packet = JSON.parse(
              decoder.decode(bytes)
            );

            if (packet.type === "ready") {
              console.log("V.E.D.A. agent is ready!");

              setReady(true);
              stopHandshake();
            } else if (
              packet.type === "message" &&
              ["user", "assistant"].includes(packet.role)
            ) {
              setMessages((old) => [
                ...old,
                {
                  role: packet.role,
                  text: packet.text,
                  id: crypto.randomUUID(),
                },
              ]);
            } else if (packet.type === "error") {
                setError(packet.message || "Chat error");
            } else if (packet.type === "memory_suggestion") {
                refreshMemoryData();
                setShowMemoryCenter(true);
}

          } catch (err) {
            stopHandshake();
            console.warn(
              "Invalid V.E.D.A. chat packet",
              err
            );
          }
        }
      );

      // Play voice responses only in Voice mode.
      connection.on(
        RoomEvent.TrackSubscribed,
        (track) => {
          if (track.kind !== "audio") return;

          const audioElement = track.attach();
          audioElement.autoplay = true;
          audioElement.muted =
            modeRef.current === "text";
          audioElement.dataset.vedaAudio = "true";

          document.body.appendChild(audioElement);
        }
      );

      connection.on(
        RoomEvent.TrackUnsubscribed,
        (track) => {
          track.detach().forEach((element) => {
            element.remove();
          });
        }
      );

      await connection.connect(
        serverUrl,
        participantToken
      );
      startHandshake(connection);
      // Do not activate the microphone in Text mode.
      await connection.localParticipant
        .setMicrophoneEnabled(
          modeRef.current === "voice"
        );

      setConnected(true);
      setStatus("CONNECTED");
    } catch (err) {
      console.error(
        "V.E.D.A. connection error:",
        err
      );

      setError(err?.message ?? String(err));

      roomRef.current?.disconnect();
      roomRef.current = null;

      cleanAudio();
      setConnected(false);
      setReady(false);
      refreshHistory();
      setStatus("CONNECTION FAILED");
    }
  }

  
  function stopAssistant() {
    roomRef.current?.disconnect();
    roomRef.current = null;

    stopHandshake();
    cleanAudio();

    setConnected(false);
    setReady(false);
    setStatus("DISCONNECTED");

    // Update the sidebar with saved conversations.
    refreshHistory();
  }


  async function sendMessage(event) {
    event.preventDefault();

    const text = draft.trim();
    if (selectedHistoryId !== null) {
      return;
    }
    if (
      !text ||
      !connected ||
      !ready ||
      !roomRef.current
    ) {
      return;
    }

    setError("");

    try {
      await roomRef.current.localParticipant.publishData(
        encoder.encode(
          JSON.stringify({
            type: "user_message",
            text,
          })
        ),
        {
          reliable: true,
          topic: CHAT_TOPIC,
        }
      );

      // Show the user's typed message immediately.
      setMessages((old) => [
        ...old,
        {
          role: "user",
          text,
          id: crypto.randomUUID(),
        },
      ]);

      setDraft("");
    } catch (err) {
      setError(
        `Message not sent: ${err.message}`
      );
    }
  }


  async function memoryApi(path, method = "GET", body = null) {
    const url = `${HISTORY_API}${path}`;

    console.log(`[MEMORY] ${method} ${url}`);

    let response;

    try {
      response = await fetch(url, {
        method,
        ...(body !== null
          ? {
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            }
          : {}),
      });
    } catch (err) {
      console.error("[MEMORY] Network error:", err);

      throw new Error(
        `Cannot reach memory API: ${err.message}`
      );
    }

    const raw = await response.text();

    let data = {};

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(
        `HTTP ${response.status}: invalid server response`
      );
    }

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${
          data.error || "Request failed"
        }`
      );
    }

    console.log(
      `[MEMORY] ${method} succeeded`,
      data
    );

    return data;
  }

  async function decideMemory(suggestionId, action) {
    setMemoryBusy(`suggestion-${suggestionId}`);
    setMemoryError("");

    console.log(
      `[MEMORY] Attempting to ${action} suggestion`,
      suggestionId
    );

    try {
      await memoryApi(
        `/memory-suggestions/${suggestionId}/${action}`,
        "POST",
        {}
      );

      console.log(
        `[MEMORY] Suggestion ${action} completed`
      );

      await refreshMemoryData();
    } catch (err) {
      console.error(
        `[MEMORY] ${action} failed:`,
        err
      );

      setMemoryError(
        `Unable to ${action} suggestion: ${err.message}`
      );
    } finally {
      setMemoryBusy(null);
    }
  }



  
  async function saveMemoryEdit(event) {
    event.preventDefault();

    if (!editingMemory) return;

    setMemoryBusy(`memory-${editingMemory.id}`);
    setMemoryError("");

    try {
      await memoryApi(
        `/memories/${editingMemory.id}`,
        "PATCH",
        {
          category: editingMemory.category,
          content: editingMemory.content,
        }
      );

      setEditingMemory(null);

      await refreshMemoryData();
    } catch (err) {
      console.error("[MEMORY] Edit failed:", err);

      setMemoryError(
        `Unable to edit memory: ${err.message}`
      );
    } finally {
      setMemoryBusy(null);
    }
  }


  
  async function removeMemory(memoryId) {
    setMemoryBusy(`memory-${memoryId}`);
    setMemoryError("");

    try {
      await memoryApi(
        `/memories/${memoryId}`,
        "DELETE"
      );

      setConfirmDeleteId(null);
      await refreshMemoryData();
    } catch (err) {
      console.error("[MEMORY] Delete failed:", err);

      setMemoryError(
        `Unable to delete memory: ${err.message}`
      );
    } finally {
      setMemoryBusy(null);
    }
  }



  const visibleMessages =
    selectedHistoryId === null ? messages : savedMessages;

  return (
    <main className="ai-assistant">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">V</span>
          <div>
            <h1>V.E.D.A</h1>
            <p>PERSONAL ASSISTANT</p>
          </div>
        </div>

        <div className="system-status">
          <span className="status-dot" />
          <span>{status}</span>
        </div>
      </header>

      <section className="main-panel">
        <div className="greeting">
          <p className="eyebrow">
            PERSONAL AI SYSTEM
          </p>
          <h2>Welcome back.</h2>
          <p className="subtitle">
            Talk or type to your assistant.
          </p>
        </div>

        <div className="orb-container">
          <div
            className={`orb ${connected && mode === "voice"
              ? "listening"
              : ""
              }`}
          >
            <div className="orb-ring ring-one" />
            <div className="orb-ring ring-two" />
            <div className="orb-core">
              <span>V</span>
            </div>
          </div>

          <p className="orb-status">
            {!connected
              ? "STANDING BY"
              : mode === "voice"
                ? "VOICE MODE"
                : "TEXT MODE"}
          </p>

          <p className="orb-caption">
            {!connected
              ? "Ready when you are."
              : mode === "voice"
                ? "Microphone enabled."
                : "Microphone off. Replies are silent."}
          </p>
        </div>

        <div className="action-row">
          <button
            className="primary-button"
            onClick={
              connected
                ? stopAssistant
                : startAssistant
            }
            disabled={status === "CONNECTING"}
          >
            {status === "CONNECTING"
              ? "Connecting..."
              : connected
                ? "Disconnect"
                : "Connect to V.E.D.A."}
          </button>
        </div>

        {error && (
          <p
            role="alert"
            className="error-message"
          >
            Error: {error}
          </p>
        )}

        <section
          className="veda-memory-center"
          aria-label="Memory center"
        >
          <div className="veda-memory-heading">
            <div>
              <h3>Memory Center</h3>
              <p>
                {memorySuggestions.length} pending suggestions
                {" · "}
                {savedMemories.length} saved memories
              </p>
            </div>

            <div className="veda-memory-actions">
              <button type="button" onClick={refreshMemoryData}>
                Refresh
              </button>

              <button
                type="button"
                onClick={() =>
                  setShowMemoryCenter(!showMemoryCenter)
                }
              >
                {showMemoryCenter ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {showMemoryCenter && (
            <div className="veda-memory-body">
              {memoryError && (
                <p role="alert" className="veda-memory-error">
                  {memoryError}
                </p>
              )}

              <h4>Pending approval</h4>

              {memorySuggestions.length === 0 && (
                <p className="veda-memory-muted">
                  No pending suggestions.
                </p>
              )}

              {memorySuggestions.map((suggestion) => (
                <article
                  className="veda-memory-card"
                  key={suggestion.id}
                >
                  <span className="veda-memory-category">
                    {suggestion.category}
                  </span>

                  <p>{suggestion.content}</p>

                  <div className="veda-memory-buttons">
                    <button
                      type="button"
                      disabled={memoryBusy !== null}
                      onClick={() =>
                        decideMemory(suggestion.id, "approve")
                      }
                    >
                      Approve
                    </button>

                    <button
                      type="button"
                      disabled={memoryBusy !== null}
                      onClick={() =>
                        decideMemory(suggestion.id, "dismiss")
                      }
                    >
                      Dismiss
                    </button>
                  </div>
                </article>
              ))}

              <h4>Approved memories</h4>

              {savedMemories.length === 0 && (
                <p className="veda-memory-muted">
                  No approved memories yet.
                </p>
              )}

              {savedMemories.map((memory) => (
                <article
                  className="veda-memory-card"
                  key={memory.id}
                >
                  {editingMemory?.id === memory.id ? (
                    <form
                      className="veda-memory-edit"
                      onSubmit={saveMemoryEdit}
                    >
                      <select
                        value={editingMemory.category}
                        onChange={(event) =>
                          setEditingMemory({
                            ...editingMemory,
                            category: event.target.value,
                          })
                        }
                      >
                        {[
                          "project",
                          "preference",
                          "goal",
                          "workflow",
                          "personal_context",
                          "other",
                        ].map((category) => (
                          <option
                            key={category}
                            value={category}
                          >
                            {category}
                          </option>
                        ))}
                      </select>

                      <textarea
                        rows={3}
                        maxLength={300}
                        value={editingMemory.content}
                        onChange={(event) =>
                          setEditingMemory({
                            ...editingMemory,
                            content: event.target.value,
                          })
                        }
                      />

                      <div className="veda-memory-buttons">
                        <button
                          type="submit"
                          disabled={memoryBusy !== null}
                        >
                          Save
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            setEditingMemory(null)
                          }
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <span className="veda-memory-category">
                        {memory.category}
                      </span>

                      <p>{memory.content}</p>

                      <div className="veda-memory-buttons">
                        <button
                          type="button"
                          onClick={() =>
                            setEditingMemory(memory)
                          }
                        >
                          Edit
                        </button>

                        
                      {confirmDeleteId === memory.id ? (
                        <>
                          <button
                            type="button"
                            disabled={memoryBusy !== null}
                            onClick={() => removeMemory(memory.id)}
                          >
                            Confirm delete
                          </button>

                          <button
                            type="button"
                            disabled={memoryBusy !== null}
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={memoryBusy !== null}
                          onClick={() => setConfirmDeleteId(memory.id)}
                        >
                          Delete
                        </button>
                      )}

                      </div>
                    </>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        {/* Text conversation interface */}
        <div className="veda-history-layout">

          <aside
            className="veda-history-sidebar"
            aria-label="Conversation history"
          >
            <div className="veda-history-heading">
              <h3>History</h3>

              <button
                type="button"
                onClick={refreshHistory}
              >
                Refresh
              </button>
            </div>

            <button
              type="button"
              className="veda-new-chat"
              onClick={startNewChat}
            >
              + New chat
            </button>

            {historyError && (
              <p role="alert" className="veda-history-error">
                {historyError}
              </p>
            )}

            <div className="veda-history-list">
              {history.length === 0 && !historyError && (
                <p className="veda-history-empty">
                  No saved conversations yet.
                </p>
              )}

              {history.map((conversation) => (
                <button
                  type="button"
                  key={conversation.id}
                  className={`veda-history-item ${selectedHistoryId === conversation.id
                    ? "active"
                    : ""
                    }`}
                  onClick={() =>
                    openSavedConversation(conversation.id)
                  }
                >
                  <span className="veda-history-preview">
                    {conversation.preview}
                  </span>

                  <span className="veda-history-date">
                    {formatHistoryDate(
                      conversation.started_at
                    )}
                  </span>

                  <span className="veda-history-count">
                    {conversation.message_count} messages
                  </span>
                </button>
              ))}
            </div>
          </aside>

          {/* Your existing conversation panel starts here */}
          <section
            className="veda-chat"
            aria-label="V.E.D.A. conversation"
          >


            <div className="veda-chat-header">
              <h3>
                {selectedHistoryId === null
                  ? "Conversation"
                  : "Saved conversation"}
              </h3>

              <div
                className="veda-mode-switch"
                aria-label="Interaction mode"
              >
                <button
                  type="button"
                  className={
                    mode === "text"
                      ? "selected"
                      : ""
                  }
                  onClick={() =>
                    switchMode("text")
                  }
                >
                  Text
                </button>

                <button
                  type="button"
                  className={
                    mode === "voice"
                      ? "selected"
                      : ""
                  }
                  onClick={() =>
                    switchMode("voice")
                  }
                >
                  Voice
                </button>
              </div>
            </div>

            
            <div
              className="veda-messages"
              role="log"
              aria-live="polite"
              aria-relevant="additions"
            >
              {/* Loading an archived conversation */}
              {selectedHistoryId !== null && historyLoading && (
                <p className="veda-empty">
                  Loading saved conversation...
                </p>
              )}

              {/* No messages available */}
              {!historyLoading && visibleMessages.length === 0 && (
                <p className="veda-empty">
                  {selectedHistoryId !== null
                    ? "No saved messages in this conversation."
                    : connected && !ready
                      ? "Preparing assistant..."
                      : connected
                        ? "Start a conversation."
                        : "Connect to start a conversation."}
                </p>
              )}

              {/* Display live messages or archived messages */}
              {!historyLoading &&
                visibleMessages.map((message, index) => (
                  <div
                    key={
                      message.id ??
                      `${selectedHistoryId ?? "live"}-${index}`
                    }
                    className={`veda-message ${
                      message.role === "user"
                        ? "from-user"
                        : "from-assistant"
                    }`}
                  >
                    <strong>
                      {message.role === "user"
                        ? "You"
                        : message.role === "assistant"
                          ? "V.E.D.A."
                          : "System"}
                    </strong>

                    <p>
                      {message.text ?? message.content ?? ""}
                    </p>
                  </div>
                ))}

              <div ref={bottomRef} />
            </div>


            <form
              className="veda-compose"
              onSubmit={sendMessage}
            >
              
              <input
                aria-label="Message V.E.D.A."
                value={draft}
                onChange={(event) =>
                  setDraft(event.target.value)
                }
                placeholder={
                  selectedHistoryId !== null
                    ? "Viewing saved conversation (read-only)"
                    : connected
                      ? ready
                        ? "Message V.E.D.A..."
                        : "Waiting for agent..."
                      : "Connect to start chatting"
                }
                disabled={
                  selectedHistoryId !== null ||
                  !connected ||
                  !ready
                }
                maxLength={8000}
              />


              <button
              type="submit"
              disabled={
                selectedHistoryId !== null ||
                !connected ||
                !ready ||
                !draft.trim()
              }
            >
              Send
            </button>
            </form>
          </section>
        </div>

        <div className="info-grid">

          <article className="info-card">
            <span className="card-label">
              CONVERSATION MODEL
            </span>
            <strong>Gemini</strong>
            <span className="card-detail">
              Python agent configuration
            </span>
          </article>

          <article className="info-card">
            <span className="card-label">
              VOICE PIPELINE
            </span>
            <strong>LiveKit</strong>
            <span className="card-detail">
              {status}
            </span>
          </article>

          <article className="info-card">
            <span className="card-label">
              TOOL SYSTEM
            </span>
            <strong>MCP</strong>
            <span className="card-detail">
              Python tool server
            </span>
          </article>
        </div>
      </section>

      <footer className="footer">
        <span>AI ASSISTANT DESKTOP</span>
        <span>
          LOCAL INTERFACE · DEVELOPMENT MODE
        </span>
      </footer>
    </main>
  );
}

export default App;
