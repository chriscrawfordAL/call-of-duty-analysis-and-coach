import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { api, AppConfig, ChatMsg } from "./api";

const SUGGESTIONS = [
  "Give me a full performance review: my top 3 strengths and top 3 weaknesses.",
  "Why is my K/D low even though I out-damage opponents? What should I drill?",
  "Which DMZ loadout and armor give me the best chance to exfil?",
  "Am I improving? Compare my older matches to my most recent ones.",
  "Build me a 2-week practice plan based on my stats.",
  "Do I play worse late at night or in long sessions?",
];

const STORE = "cod-coach-chat-v1";

export function Coach({ config, endpoint }: { config: AppConfig; endpoint: string; version?: number }) {
  const key = `${STORE}:${config.catalog}.${config.schema}`;
  const [messages, setMessages] = useState<ChatMsg[]>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? (JSON.parse(raw) as ChatMsg[]) : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sessionStorage.setItem(key, JSON.stringify(messages));
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [messages, key, busy]);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    const next: ChatMsg[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const { reply } = await api.coach(config, next);
      setMessages([...next, { role: "assistant", content: reply || "_(no response)_" }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="coach">
      <div className="card chat">
        <div className="log" ref={log} aria-live="polite">
          {messages.length === 0 && (
            <div className="empty" style={{ padding: "40px 10px" }}>
              <h2>Your AI coach</h2>
              <p>
                Coach reads your stored match history from <code>{config.catalog}.{config.schema}</code> and gives advice
                grounded in your actual numbers. Pick a prompt on the right or ask anything.
              </p>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === "assistant" ? <ReactMarkdown>{m.content}</ReactMarkdown> : m.content}
            </div>
          ))}
          {busy && <div className="msg assistant typing">Coach is reviewing your matches…</div>}
          {error && <div className="error">Coach failed: {error}</div>}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
        >
          <textarea
            aria-label="Ask the coach"
            placeholder="Ask about your aim, loadouts, DMZ runs, habits…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(input);
              }
            }}
          />
          <button className="btn primary" type="submit" disabled={busy || !input.trim()}>
            Send
          </button>
        </form>
      </div>

      <aside className="suggest">
        <div className="card">
          <h3>Try asking</h3>
          <p className="sub">Answers use every upload stored so far.</p>
          <div className="suggest">
            {SUGGESTIONS.map((s) => (
              <button key={s} disabled={busy} onClick={() => void ask(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="card">
          <h3>About</h3>
          <p className="sub" style={{ marginBottom: 6 }}>
            Model endpoint: <code>{endpoint || "not configured"}</code>
          </p>
          <p className="sub" style={{ marginBottom: 6 }}>
            The SAR export has no positional, opponent, or attachment data, so Coach can't see <em>how</em> fights
            played out — only the outcomes.
          </p>
          <button className="btn" disabled={busy || messages.length === 0} onClick={() => setMessages([])}>
            Clear conversation
          </button>
        </div>
      </aside>
    </div>
  );
}
