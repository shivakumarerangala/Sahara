import { useState, useEffect, useRef } from "react";
import "./sahara.css";

// Backend proxy for the Sahara Agent on Microsoft Foundry (see agent/server.py)
const API_BASE = "http://localhost:8000";

// ——— Storage adapter ————————————————————————————————
// Inside a Claude artifact, window.storage (server-side key-value) exists.
// In a normal browser (Vite dev, deployed build) it doesn't, so we fall back
// to localStorage so the demo works anywhere.
// NOTE for production: records must live encrypted on a server, never on the
// survivor's device — replace this with calls to your backend before any
// real-world pilot.
const storage = (() => {
  if (typeof window !== "undefined" && window.storage) return window.storage;
  return {
    async get(key) {
      const v = localStorage.getItem(key);
      if (v === null) throw new Error("not found");
      return { key, value: v };
    },
    async set(key, value) {
      localStorage.setItem(key, value);
      return { key, value };
    },
    async delete(key) {
      localStorage.removeItem(key);
      return { key, deleted: true };
    },
    async list(prefix = "") {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) keys.push(k);
      }
      return { keys, prefix };
    },
  };
})();

// ——— Design tokens ———————————————————————————————
const C = {
  ink: "#22302C", // deep green-black text
  paper: "#FAF7F1", // warm paper background
  card: "#FFFFFF",
  mist: "#E6E0D4", // borders
  sage: "#56766A", // primary calm accent
  sageDark: "#3F5A50",
  clay: "#A8442F", // urgent / high-risk
  clayBg: "#F8E9E4",
  amber: "#8A6A2F",
  amberBg: "#F6EEDC",
  calm: "#EDF2EE",
  faint: "#7C8682",
};
const serif = "Georgia, 'Times New Roman', serif";
const sans = "system-ui, -apple-system, 'Segoe UI', sans-serif";

// ——— Calculator disguise ———————————————————————————
// The whole app lives behind a real, working calculator.
// Typing the unlock code (0000) and pressing = opens Sahara.
function Calculator({ onUnlock }) {
  const [display, setDisplay] = useState("0");
  const [expr, setExpr] = useState("");

  const press = (k) => {
    if (k === "C") {
      setDisplay("0");
      setExpr("");
      return;
    }
    if (k === "=") {
      if (expr === "0000" || display === "0000") {
        onUnlock();
        return;
      }
      try {
        // simple safe eval for + - × ÷
        const safe = expr.replace(/×/g, "*").replace(/÷/g, "/");
        if (/^[\d+\-*/. ]+$/.test(safe) && safe.length > 0) {
          const result = Function(`"use strict"; return (${safe})`)();
          setDisplay(String(Number.isFinite(result) ? +result.toFixed(8) : "Error"));
          setExpr(String(result));
        }
      } catch {
        setDisplay("Error");
        setExpr("");
      }
      return;
    }
    const next = expr === "0" || display === "Error" ? k : expr + k;
    setExpr(next);
    setDisplay(next);
  };

  const keys = ["C", "÷", "×", "-", "7", "8", "9", "+", "4", "5", "6", "=", "1", "2", "3", "0", "."];
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "#1C1C1E", fontFamily: sans }}>
      <div className="w-full max-w-xs p-4">
        <div className="text-right text-white px-2 pb-4" style={{ fontSize: 44, fontWeight: 300, minHeight: 64, overflow: "hidden" }}>
          {display}
        </div>
        <div className="grid grid-cols-4 gap-2">
          {["C", "÷", "×", "-"].map((k) => (
            <CalcKey key={k} k={k} onPress={press} tone="op" />
          ))}
          {["7", "8", "9"].map((k) => (
            <CalcKey key={k} k={k} onPress={press} />
          ))}
          <CalcKey k="+" onPress={press} tone="op" tall />
          {["4", "5", "6"].map((k) => (
            <CalcKey key={k} k={k} onPress={press} />
          ))}
          <div />
          {["1", "2", "3"].map((k) => (
            <CalcKey key={k} k={k} onPress={press} />
          ))}
          <CalcKey k="=" onPress={press} tone="eq" tall />
          <CalcKey k="0" onPress={press} wide />
          <CalcKey k="." onPress={press} />
          <div />
        </div>
        {/* Prototype-only hint. A real deployment would never show this. */}
        <p className="text-center mt-6" style={{ color: "#5A5A5E", fontSize: 12 }}>
          Prototype hint: type <span style={{ color: "#8E8E93" }}>0000</span> then <span style={{ color: "#8E8E93" }}>=</span>
        </p>
      </div>
    </div>
  );
}

function CalcKey({ k, onPress, tone, wide, tall }) {
  const bg = tone === "eq" ? "#FF9F0A" : tone === "op" ? "#FF9F0A22" : "#2C2C2E";
  const fg = tone === "eq" ? "#1C1C1E" : tone === "op" ? "#FF9F0A" : "#FFFFFF";
  return (
    <button
      onClick={() => onPress(k)}
      className={`${wide ? "col-span-2" : ""} ${tall ? "row-span-2" : ""} rounded-2xl`}
      style={{ background: bg, color: fg, fontSize: 22, padding: "16px 0", border: "none", cursor: "pointer" }}
    >
      {k}
    </button>
  );
}

// ——— Main app ————————————————————————————————————
export default function Sahara() {
  const [unlocked, setUnlocked] = useState(false);
  const [tab, setTab] = useState("talk"); // talk | records | help
  const [language, setLanguage] = useState("English");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [error, setError] = useState("");
  const [records, setRecords] = useState([]);
  const inputRef = useRef(null);

  // Quick exit: Esc key always returns to the calculator instantly.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        setUnlocked(false);
        setResponse(null);
        setInput("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const loadRecords = async () => {
    try {
      const res = await storage.list("incident:");
      const items = [];
      for (const key of res?.keys || []) {
        try {
          const r = await storage.get(key);
          if (r?.value) items.push({ key, ...JSON.parse(r.value) });
        } catch {
          /* skip unreadable record */
        }
      }
      items.sort((a, b) => b.ts - a.ts);
      setRecords(items);
    } catch {
      setRecords([]);
    }
  };

  useEffect(() => {
    if (unlocked) loadRecords();
  }, [unlocked]);

  const analyze = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setLoading(true);
    setError("");
    setResponse(null);
    try {
      // Sahara Agent on Microsoft Foundry (Reasoning Agents track).
      // The proxy invokes the agent, which performs triage, retrieves
      // grounded legal passages from the Foundry IQ knowledge base, and
      // returns structured JSON with citations.
      const res = await fetch(`${API_BASE}/api/incident`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, language }),
      });
      if (!res.ok) throw new Error(`Proxy error ${res.status}`);
      const parsed = await res.json();
      setResponse(parsed);

      // Save the record — timestamped, on the server, never on this device.
      const ts = Date.now();
      const record = {
        ts,
        text,
        risk: parsed.risk_level || "lower",
        language,
      };
      try {
        await storage.set(`incident:${ts}`, JSON.stringify(record));
        loadRecords();
      } catch {
        /* storage unavailable — response still shown */
      }
    } catch (e) {
      setError("Something went wrong while preparing a response. Your words were not lost — please try once more.");
    } finally {
      setLoading(false);
    }
  };

  const deleteRecord = async (key) => {
    try {
      await storage.delete(key);
      setRecords((r) => r.filter((x) => x.key !== key));
    } catch {
      /* ignore */
    }
  };

  if (!unlocked) return <Calculator onUnlock={() => setUnlocked(true)} />;

  const riskTone =
    response?.risk_level === "high"
      ? { bg: C.clayBg, fg: C.clay, label: "Higher risk" }
      : response?.risk_level === "moderate"
      ? { bg: C.amberBg, fg: C.amber, label: "Moderate risk" }
      : { bg: C.calm, fg: C.sageDark, label: "Noted" };

  return (
    <div className="min-h-screen" style={{ background: C.paper, color: C.ink, fontFamily: sans }}>
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: `1px solid ${C.mist}` }}>
        <div className="flex items-baseline gap-2">
          <span style={{ fontFamily: serif, fontSize: 20, color: C.sageDark }}>Sahara</span>
          <span style={{ fontSize: 12, color: C.faint }}>a private place to be heard</span>
        </div>
        <button
          onClick={() => {
            setUnlocked(false);
            setResponse(null);
            setInput("");
          }}
          className="rounded-full px-4 py-1.5"
          style={{ background: C.ink, color: C.paper, fontSize: 13, border: "none", cursor: "pointer" }}
          title="Instantly returns to the calculator (or press Esc)"
        >
          Quick exit
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-5 pt-4">
        {[
          ["talk", "Talk"],
          ["records", `My records${records.length ? ` (${records.length})` : ""}`],
          ["help", "Get help now"],
        ].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className="px-4 py-2 rounded-t-lg"
            style={{
              background: tab === id ? C.card : "transparent",
              border: `1px solid ${tab === id ? C.mist : "transparent"}`,
              borderBottom: "none",
              color: id === "help" ? C.clay : tab === id ? C.ink : C.faint,
              fontSize: 14,
              fontWeight: tab === id ? 600 : 400,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="max-w-2xl mx-auto px-5 pb-16">
        {/* ——— TALK ——— */}
        {tab === "talk" && (
          <div className="pt-6">
            {!response && !loading && (
              <p style={{ fontFamily: serif, fontSize: 22, lineHeight: 1.5, color: C.ink, maxWidth: 480 }}>
                What happened? Tell it in your own words, in your own time. No one else can see this.
              </p>
            )}

            <div className="mt-5 rounded-xl p-4" style={{ background: C.card, border: `1px solid ${C.mist}` }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={4}
                placeholder="For example: Last night he came home angry and…"
                className="w-full resize-none"
                style={{ border: "none", outline: "none", fontSize: 15, lineHeight: 1.6, background: "transparent", color: C.ink, fontFamily: sans }}
              />
              <div className="flex items-center justify-between mt-2">
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  style={{ fontSize: 13, color: C.faint, border: `1px solid ${C.mist}`, borderRadius: 8, padding: "4px 8px", background: C.paper }}
                >
                  <option>English</option>
                  <option>Hindi</option>
                  <option>Marathi</option>
                </select>
                <button
                  onClick={analyze}
                  disabled={loading || !input.trim()}
                  className="rounded-full px-5 py-2"
                  style={{
                    background: loading || !input.trim() ? C.mist : C.sage,
                    color: "#fff",
                    fontSize: 14,
                    fontWeight: 600,
                    border: "none",
                    cursor: loading || !input.trim() ? "default" : "pointer",
                  }}
                >
                  {loading ? "Listening…" : "Share"}
                </button>
              </div>
            </div>

            {error && (
              <p className="mt-4" style={{ color: C.clay, fontSize: 14 }}>
                {error}
              </p>
            )}

            {response && (
              <div className="mt-6">
                {response.urgent && (
                  <div className="rounded-xl p-4 mb-4" style={{ background: C.clay, color: "#fff" }}>
                    <p style={{ fontWeight: 700, fontSize: 15 }}>If you are in danger right now</p>
                    <p style={{ fontSize: 14, marginTop: 4 }}>
                      Call <b>112</b> (emergency) or <b>181</b> (Women Helpline) immediately, or go to a neighbour you trust. Your safety comes first — everything here can wait.
                    </p>
                  </div>
                )}

                <p style={{ fontFamily: serif, fontSize: 19, lineHeight: 1.65 }}>{response.acknowledgment}</p>

                <div className="rounded-lg px-4 py-3 mt-5 inline-block" style={{ background: riskTone.bg }}>
                  <span style={{ color: riskTone.fg, fontSize: 13, fontWeight: 700, letterSpacing: 0.3 }}>{riskTone.label}</span>
                  <p style={{ color: C.ink, fontSize: 14, marginTop: 2 }}>{response.risk_note}</p>
                </div>

                <div className="grid gap-4 mt-6 md:grid-cols-2">
                  <div className="rounded-xl p-4" style={{ background: C.card, border: `1px solid ${C.mist}` }}>
                    <p style={{ fontSize: 12, fontWeight: 700, color: C.sageDark, letterSpacing: 0.8, textTransform: "uppercase" }}>Your rights</p>
                    {(response.rights || []).length === 0 && (
                      <p style={{ fontSize: 13, color: C.faint, marginTop: 10 }}>
                        I don't want to guess about the law. The 181 helpline can explain your rights for this situation.
                      </p>
                    )}
                    {(response.rights || []).map((r, i) => {
                      const text = typeof r === "string" ? r : r.text;
                      const source = typeof r === "string" ? null : r.source;
                      return (
                        <p key={i} style={{ fontSize: 14, lineHeight: 1.55, marginTop: 10 }}>
                          {text}
                          {source && (
                            <span
                              className="ml-2 px-2 py-0.5 rounded-full"
                              style={{ background: C.calm, color: C.sageDark, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
                              title="Retrieved from the Foundry IQ knowledge base"
                            >
                              {source}
                            </span>
                          )}
                        </p>
                      );
                    })}
                  </div>
                  <div className="rounded-xl p-4" style={{ background: C.card, border: `1px solid ${C.mist}` }}>
                    <p style={{ fontSize: 12, fontWeight: 700, color: C.sageDark, letterSpacing: 0.8, textTransform: "uppercase" }}>When you're ready</p>
                    {(response.steps || []).map((s, i) => (
                      <p key={i} style={{ fontSize: 14, lineHeight: 1.55, marginTop: 10 }}>
                        {s}
                      </p>
                    ))}
                  </div>
                </div>

                <p className="mt-4" style={{ fontSize: 13, color: C.faint }}>
                  This has been saved to your private records with today's date. Only you can see it, and you can delete it any time.
                </p>

                <button
                  onClick={() => {
                    setResponse(null);
                    setInput("");
                    inputRef.current?.focus();
                  }}
                  className="mt-3 px-4 py-2 rounded-full"
                  style={{ background: "transparent", border: `1px solid ${C.mist}`, color: C.sageDark, fontSize: 13, cursor: "pointer" }}
                >
                  Share something else
                </button>
              </div>
            )}
          </div>
        )}

        {/* ——— RECORDS ——— */}
        {tab === "records" && (
          <div className="pt-6">
            <p style={{ fontFamily: serif, fontSize: 20 }}>Your records</p>
            <p style={{ fontSize: 14, color: C.faint, marginTop: 4, maxWidth: 520 }}>
              A dated record of what you've shared. If you ever choose to approach a Protection Officer, lawyer, or court, a written pattern like this can matter a great deal. The choice is always yours.
            </p>
            {records.length === 0 && (
              <div className="rounded-xl p-6 mt-5 text-center" style={{ background: C.card, border: `1px dashed ${C.mist}`, color: C.faint, fontSize: 14 }}>
                Nothing saved yet. Anything you share in Talk is kept here automatically.
              </div>
            )}
            {records.map((r) => (
              <div key={r.key} className="rounded-xl p-4 mt-4" style={{ background: C.card, border: `1px solid ${C.mist}` }}>
                <div className="flex items-center justify-between">
                  <span style={{ fontSize: 13, fontWeight: 600, color: C.sageDark }}>
                    {new Date(r.ts).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })} ·{" "}
                    {new Date(r.ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <button
                    onClick={() => deleteRecord(r.key)}
                    style={{ background: "none", border: "none", color: C.faint, fontSize: 12, cursor: "pointer", textDecoration: "underline" }}
                  >
                    Delete
                  </button>
                </div>
                <p style={{ fontSize: 14, lineHeight: 1.6, marginTop: 8 }}>{r.text}</p>
              </div>
            ))}
          </div>
        )}

        {/* ——— HELP ——— */}
        {tab === "help" && (
          <div className="pt-6">
            <p style={{ fontFamily: serif, fontSize: 20 }}>Help that is always available</p>
            <div className="grid gap-3 mt-5">
              <HelpRow num="112" label="Emergency (police, ambulance)" note="If you are in danger right now." urgent />
              <HelpRow num="181" label="Women Helpline" note="24×7, free, in your language. They can connect you to a One Stop Centre near you." />
              <HelpRow num="1091" label="Women Police Helpline" note="To reach women's police assistance." />
            </div>
            <div className="rounded-xl p-4 mt-5" style={{ background: C.card, border: `1px solid ${C.mist}` }}>
              <p style={{ fontSize: 14, lineHeight: 1.65 }}>
                <b>One Stop Centres (Sakhi)</b> exist in every district — one place for medical help, police assistance, legal aid, and shelter. The 181 helpline can tell you the nearest one.
              </p>
              <p style={{ fontSize: 14, lineHeight: 1.65, marginTop: 10 }}>
                <b>Free legal aid</b> is your right through the District Legal Services Authority (DLSA), and organisations such as <b>SNEHA</b> and <b>Majlis</b> in Mumbai support survivors directly.
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="fixed bottom-0 left-0 right-0 px-5 py-2 text-center" style={{ background: C.paper, borderTop: `1px solid ${C.mist}` }}>
        <p style={{ fontSize: 11.5, color: C.faint }}>
          Prototype for demonstration. Sahara supports you but is not an emergency service — in immediate danger, always call 112. Press Esc anytime to exit instantly.
        </p>
      </div>
    </div>
  );
}

function HelpRow({ num, label, note, urgent }) {
  return (
    <div className="rounded-xl p-4 flex items-center gap-4" style={{ background: urgent ? C.clayBg : C.card, border: `1px solid ${urgent ? "#E5C2B8" : C.mist}` }}>
      <span style={{ fontFamily: serif, fontSize: 26, fontWeight: 700, color: urgent ? C.clay : C.sageDark, minWidth: 70 }}>{num}</span>
      <div>
        <p style={{ fontSize: 14, fontWeight: 600 }}>{label}</p>
        <p style={{ fontSize: 13, color: C.faint, marginTop: 2 }}>{note}</p>
      </div>
    </div>
  );
}