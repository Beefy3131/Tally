import React, { useState, useEffect, useRef } from "react";
import { dbGet, dbSet, requestPersistence } from "./db";

/* ============ CONSTANTS ============ */
const COLORS = ["#FFB454", "#6FD08C", "#5EB3F6", "#F67E7E", "#C58BF2", "#F6D65E"];
const EMOJIS = ["🔥","💧","🏋️","📖","☕","🚗","🎮","💰","🏃","😴","🍺","📵","🧠","🔧","📦","✅","💩","🍗","🍕","🍔"];
const MILESTONES_LOGS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const MILESTONES_STREAK = [3, 7, 14, 30, 60, 100, 365];

const S = {
  bg: "#14171C",
  surface: "#1D2129",
  surface2: "#242A34",
  line: "#2C323D",
  text: "#E8EAED",
  muted: "#8B93A1",
  amber: "#FFB454",
};

/* ============ HELPERS ============ */
const uid = () => Math.random().toString(36).slice(2, 10);
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const todayKey = () => dayKey(Date.now());
const fmtNum = (n) => Math.round(n * 100) / 100;

function fmtAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function countsByDay(events, trackerId) {
  const map = {};
  for (const e of events) {
    if (e.trackerId !== trackerId) continue;
    const k = dayKey(e.ts);
    map[k] = (map[k] || 0) + e.delta;
  }
  return map;
}

function lastNDays(n) {
  const days = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    days.push(dayKey(d.getTime()));
  }
  return days;
}

function hourHistogram(events, trackerId) {
  const hours = new Array(24).fill(0);
  for (const e of events) {
    if (e.trackerId !== trackerId || e.delta <= 0) continue;
    hours[new Date(e.ts).getHours()]++;
  }
  return hours;
}

function fmtHour(h) {
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${h < 12 ? "AM" : "PM"}`;
}

function peakWindow(hours) {
  let best = 0, bestStart = -1;
  for (let h = 0; h < 24; h++) {
    const sum = hours[h] + hours[(h + 1) % 24];
    if (sum > best) { best = sum; bestStart = h; }
  }
  if (best === 0) return null;
  return { start: bestStart, end: (bestStart + 2) % 24, count: best };
}

/* Build streak — "count" mode: consecutive days WITH logs (one freeze per 7 streak-days).
   "avoid" mode: consecutive days WITHOUT logs (clean streak), back to tracker creation. */
function calcStreak(dayCounts, tracker) {
  if (tracker && tracker.mode === "avoid") {
    let streak = 0;
    const d = new Date();
    const createdDay = dayKey(tracker.createdAt || Date.now());
    for (let i = 0; i < 3650; i++) {
      const k = dayKey(d.getTime());
      if (dayCounts[k] > 0) break;
      streak++;
      if (k === createdDay) break;
      d.setDate(d.getDate() - 1);
    }
    return { days: streak, freezes: 0 };
  }
  let streak = 0, freezes = 0, sinceFreeze = 99;
  const d = new Date();
  if (!dayCounts[dayKey(d.getTime())] || dayCounts[dayKey(d.getTime())] <= 0) {
    d.setDate(d.getDate() - 1);
  }
  while (true) {
    const k = dayKey(d.getTime());
    if (dayCounts[k] > 0) {
      streak++;
      sinceFreeze++;
      d.setDate(d.getDate() - 1);
    } else if (streak > 0 && sinceFreeze >= 7) {
      freezes++;
      sinceFreeze = 0;
      streak++;
      d.setDate(d.getDate() - 1);
    } else break;
  }
  return { days: streak, freezes };
}

/* Longest clean gap for avoid mode (best streak) */
function bestCleanStreak(events, tracker) {
  const slipDays = [...new Set(events.filter((e) => e.trackerId === tracker.id && e.delta > 0).map((e) => dayKey(e.ts)))].sort();
  const created = new Date(tracker.createdAt || Date.now());
  const points = [created, ...slipDays.map((k) => new Date(k + "T12:00")), new Date()];
  let best = 0;
  for (let i = 1; i < points.length; i++) {
    const gap = Math.floor((points[i] - points[i - 1]) / 86400000);
    if (gap > best) best = gap;
  }
  return best;
}

/* ============ APP ============ */
export default function App() {
  const [trackers, setTrackers] = useState([]);
  const [events, setEvents] = useState([]);
  const [notes, setNotes] = useState({}); // { dayKey: "text" }
  const [surprises, setSurprises] = useState([]); // [{id, label, ts}]
  const [ready, setReady] = useState(false);
  const [view, setView] = useState({ page: "home" }); // home | detail | form | focus | compare
  const [pulse, setPulse] = useState(null);
  const [toast, setToast] = useState(null);
  const [amountFor, setAmountFor] = useState(null);
  const saveTimer = useRef(null);
  const toastTimer = useRef(null);
  const quickLogged = useRef(false);

  const fireToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };

  /* load */
  useEffect(() => {
    (async () => {
      try {
        const data = await dbGet("data");
        if (data) {
          setTrackers(data.trackers || []);
          setEvents(data.events || []);
          setNotes(data.notes || {});
          setSurprises(data.surprises || []);
        }
      } catch (e) {
        console.error("load failed", e);
      }
      requestPersistence();
      setReady(true);
    })();
  }, []);

  /* save (debounced) */
  useEffect(() => {
    if (!ready) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await dbSet("data", { trackers, events, notes, surprises });
      } catch (e) {
        console.error("save failed", e);
      }
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [trackers, events, notes, surprises, ready]);

  /* quick-log from app shortcut (?quicklog=1) — Android home screen long-press */
  useEffect(() => {
    if (!ready || quickLogged.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("quicklog") && trackers.length > 0) {
      quickLogged.current = true;
      const t = trackers[0];
      window.history.replaceState({}, "", window.location.pathname);
      if (t.unit) setAmountFor(t);
      else {
        logEvent(t.id, 1);
        fireToast(`${t.emoji} ${t.name} logged!`);
      }
    }
  }, [ready, trackers]); // eslint-disable-line

  /* actions */
  const logEvent = (id, value) => {
    const next = [...events, { id: uid(), trackerId: id, ts: Date.now(), delta: value }];
    setEvents(next);
    setPulse(id);
    setTimeout(() => setPulse(null), 300);
    if (navigator.vibrate) navigator.vibrate(10);

    const t = trackers.find((x) => x.id === id);
    if (!t) return;

    /* surprise finds — random/quirky rewards */
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const candidates = [];
    if (h === 11 && m === 11) candidates.push({ id: "wish", label: "⏰ 11:11 LOG" });
    if (h >= 2 && h < 5) candidates.push({ id: "owl", label: "🦉 NIGHT OWL" });
    if (h >= 5 && h < 7) candidates.push({ id: "bird", label: "🐦 EARLY BIRD" });
    if (now.getDay() === 0 && events.filter((e) => new Date(e.ts).getDay() === 0).length === 0)
      candidates.push({ id: "sunday", label: "🌞 FIRST SUNDAY" });
    if (Math.random() < 0.01) candidates.push({ id: "lucky", label: "🎲 LUCKY LOG" });
    const fresh = candidates.filter((c) => !surprises.some((s) => s.id === c.id));
    if (fresh.length > 0) {
      setSurprises((s) => [...s, ...fresh.map((f) => ({ ...f, ts: Date.now() }))]);
      fireToast(`✨ Surprise find: ${fresh[0].label}`);
      return;
    }

    if (t.mode === "avoid") return; // no positive milestones for slips

    const logsBefore = events.filter((e) => e.trackerId === id && e.delta > 0).length;
    const logHit = MILESTONES_LOGS.find((mm) => logsBefore < mm && logsBefore + 1 >= mm);
    if (logHit) {
      fireToast(`🏆 ${logHit} logs on ${t.emoji} ${t.name}!`);
      return;
    }
    const prevStreak = calcStreak(countsByDay(events, id), t).days;
    const newStreak = calcStreak(countsByDay(next, id), t).days;
    const streakHit = MILESTONES_STREAK.find((mm) => prevStreak < mm && newStreak >= mm);
    if (streakHit) fireToast(`🔥 ${streakHit}-day streak on ${t.emoji} ${t.name}!`);
  };

  const increment = (id) => logEvent(id, 1);

  const undo = (id) => {
    setEvents((ev) => {
      const tk = todayKey();
      for (let i = ev.length - 1; i >= 0; i--) {
        if (ev[i].trackerId === id && ev[i].delta > 0 && dayKey(ev[i].ts) === tk) {
          return [...ev.slice(0, i), ...ev.slice(i + 1)];
        }
      }
      return ev;
    });
  };

  const saveTracker = (t) => {
    setTrackers((ts) =>
      t.id && ts.some((x) => x.id === t.id)
        ? ts.map((x) => (x.id === t.id ? { ...x, ...t } : x))
        : [...ts, { ...t, id: uid(), createdAt: Date.now() }]
    );
    setView({ page: "home" });
  };

  const deleteTracker = (id) => {
    setTrackers((ts) => ts.filter((t) => t.id !== id));
    setEvents((ev) => ev.filter((e) => e.trackerId !== id));
    setView({ page: "home" });
  };

  const setNote = (day, text) => {
    setNotes((n) => {
      const next = { ...n };
      if (text.trim()) next[day] = text.trim();
      else delete next[day];
      return next;
    });
  };

  if (!ready)
    return (
      <Shell>
        <div style={{ color: S.muted, textAlign: "center", paddingTop: 80, fontFamily: "'Rajdhani', sans-serif", fontSize: 18, letterSpacing: 2 }}>
          LOADING…
        </div>
      </Shell>
    );

  return (
    <Shell>
      {view.page === "home" && (
        <Home
          trackers={trackers}
          events={events}
          pulse={pulse}
          onInc={increment}
          onUndo={undo}
          onDetail={(t) => setView({ page: "detail", tracker: t })}
          onAdd={() => setView({ page: "form" })}
          onAmount={(t) => setAmountFor(t)}
          onCompare={() => setView({ page: "compare" })}
          onImport={(data) => {
            setTrackers(data.trackers || []);
            setEvents(data.events || []);
            setNotes(data.notes || {});
            setSurprises(data.surprises || []);
          }}
          notes={notes}
          surprises={surprises}
        />
      )}
      {view.page === "detail" && (
        <Detail
          tracker={trackers.find((t) => t.id === view.tracker.id) || view.tracker}
          events={events}
          notes={notes}
          surprises={surprises}
          onSetNote={setNote}
          onBack={() => setView({ page: "home" })}
          onEdit={(t) => setView({ page: "form", tracker: t })}
          onFocus={(t) => setView({ page: "focus", tracker: t })}
          onDelete={deleteTracker}
        />
      )}
      {view.page === "form" && (
        <TrackerForm
          tracker={view.tracker}
          onSave={saveTracker}
          onCancel={() => setView(view.tracker ? { page: "detail", tracker: view.tracker } : { page: "home" })}
        />
      )}
      {view.page === "focus" && (
        <FocusMode
          tracker={trackers.find((t) => t.id === view.tracker.id) || view.tracker}
          events={events}
          pulse={pulse}
          onTap={(t) => (t.unit ? setAmountFor(t) : increment(t.id))}
          onUndo={undo}
          onExit={() => setView({ page: "detail", tracker: view.tracker })}
        />
      )}
      {view.page === "compare" && (
        <Compare trackers={trackers} events={events} onBack={() => setView({ page: "home" })} />
      )}
      {amountFor && (
        <AmountModal
          t={amountFor}
          onSubmit={(v) => { logEvent(amountFor.id, v); setAmountFor(null); }}
          onClose={() => setAmountFor(null)}
        />
      )}
      {toast && (
        <div style={{ position: "fixed", top: "calc(14px + env(safe-area-inset-top))", left: "50%", transform: "translateX(-50%)", background: S.surface2, border: `1px solid ${S.amber}77`, color: S.text, padding: "10px 18px", borderRadius: 12, fontSize: 14, zIndex: 60, boxShadow: "0 4px 20px #0008", animation: "fadeUp .25s ease", whiteSpace: "nowrap" }}>
          {toast}
        </div>
      )}
    </Shell>
  );
}

/* ============ SHELL ============ */
function Shell({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: S.bg, color: S.text, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        button { font-family: inherit; cursor: pointer; }
        @keyframes tick { 0% { transform: scale(1); } 40% { transform: scale(1.12); } 100% { transform: scale(1); } }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
        input:focus, button:focus-visible, select:focus { outline: 2px solid ${S.amber}; outline-offset: 2px; }
        input:focus, select:focus { outline-offset: 0; }
      `}</style>
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px 40px", paddingTop: "calc(20px + env(safe-area-inset-top))", paddingBottom: "calc(40px + env(safe-area-inset-bottom))" }}>{children}</div>
    </div>
  );
}

/* ============ HOME ============ */
function Home({ trackers, events, pulse, onInc, onUndo, onDetail, onAdd, onAmount, onCompare, onImport, notes, surprises }) {
  const fileRef = useRef(null);

  const exportData = () => {
    const blob = new Blob([JSON.stringify({ trackers, events, notes, surprises }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tally-backup-${todayKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importData = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.trackers) || !Array.isArray(data.events)) throw new Error("bad format");
        if (window.confirm("Replace all current data with this backup?")) onImport(data);
      } catch {
        window.alert("That file isn't a valid Tally backup.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const tk = todayKey();
  const todayTotal = events.filter((e) => dayKey(e.ts) === tk && e.delta > 0).length;

  return (
    <div style={{ animation: "fadeUp .25s ease" }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <h1 style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 30, letterSpacing: 3, margin: 0 }}>
          TALLY
        </h1>
        <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 15, color: S.muted, letterSpacing: 1 }}>
          {new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }).toUpperCase()}
        </div>
      </header>
      <div style={{ color: S.muted, fontSize: 13, marginBottom: 20 }}>
        {trackers.length === 0 ? "Nothing tracked yet" : `${todayTotal} log${todayTotal === 1 ? "" : "s"} today`}
      </div>

      {trackers.length === 0 && (
        <div style={{ background: S.surface, border: `1px dashed ${S.line}`, borderRadius: 14, padding: "36px 20px", textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>🎯</div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Add your first tracker</div>
          <div style={{ color: S.muted, fontSize: 13, lineHeight: 1.5 }}>
            Anything countable — coffees, workouts, sales calls, laps at the track.
          </div>
        </div>
      )}

      {trackers.map((t) => {
        const todayCount = events.filter((e) => e.trackerId === t.id && dayKey(e.ts) === tk).reduce((s, e) => s + e.delta, 0);
        const { days: streak, freezes } = calcStreak(countsByDay(events, t.id), t);
        const lastLog = [...events].reverse().find((e) => e.trackerId === t.id && e.delta > 0);
        return (
          <TrackerCard
            key={t.id}
            t={t}
            count={todayCount}
            streak={streak}
            freezes={freezes}
            lastTs={lastLog ? lastLog.ts : null}
            pulsing={pulse === t.id}
            onInc={() => (t.unit && t.mode !== "avoid" ? onAmount(t) : onInc(t.id))}
            onUndo={() => onUndo(t.id)}
            onDetail={() => onDetail(t)}
          />
        );
      })}

      <button
        onClick={onAdd}
        style={{
          width: "100%", padding: "14px", borderRadius: 14, border: `1px solid ${S.line}`,
          background: S.surface, color: S.amber, fontFamily: "'Rajdhani', sans-serif",
          fontSize: 17, fontWeight: 600, letterSpacing: 2, marginTop: 4,
        }}
      >
        + NEW TRACKER
      </button>

      {trackers.length >= 2 && (
        <button
          onClick={onCompare}
          style={{
            width: "100%", padding: "12px", borderRadius: 14, border: `1px solid ${S.line}`,
            background: "none", color: S.muted, fontFamily: "'Rajdhani', sans-serif",
            fontSize: 15, fontWeight: 600, letterSpacing: 2, marginTop: 10,
          }}
        >
          ⇄ COMPARE TRACKERS
        </button>
      )}

      <div style={{ display: "flex", justifyContent: "center", gap: 18, marginTop: 24 }}>
        <button onClick={exportData} style={{ background: "none", border: "none", color: S.muted, fontSize: 12, textDecoration: "underline", textUnderlineOffset: 2 }}>
          Export backup
        </button>
        <button onClick={() => fileRef.current?.click()} style={{ background: "none", border: "none", color: S.muted, fontSize: 12, textDecoration: "underline", textUnderlineOffset: 2 }}>
          Import backup
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" onChange={importData} style={{ display: "none" }} />
      </div>
    </div>
  );
}

function TrackerCard({ t, count, streak, freezes, lastTs, pulsing, onInc, onUndo, onDetail }) {
  const avoid = t.mode === "avoid";
  const goalHit = !avoid && t.goal && count >= t.goal;
  return (
    <div style={{ background: S.surface, border: `1px solid ${goalHit ? t.color : S.line}`, borderRadius: 14, padding: 14, marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
      <button
        onClick={onDetail}
        aria-label={`View ${t.name} history`}
        style={{ background: "none", border: "none", textAlign: "left", flex: 1, minWidth: 0, color: S.text, padding: 0 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 20 }}>{t.emoji}</span>
          <span style={{ fontWeight: 600, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
        </div>
        <div style={{ color: S.muted, fontSize: 12, marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" }}>
          {avoid ? (
            <span style={{ color: t.color }}>🛡️ {streak}d clean</span>
          ) : (
            streak > 0 && <span style={{ color: t.color }}>🔥 {streak}d streak{freezes > 0 ? " ❄️" : ""}</span>
          )}
          {lastTs && <span>{avoid ? "slipped" : "last"} {fmtAgo(lastTs)}</span>}
          {goalHit ? <span>✓ goal hit</span> : !avoid && t.goal ? <span>goal {t.goal}</span> : null}
        </div>
      </button>

      <button
        onClick={onUndo}
        aria-label={`Undo last ${t.name} log`}
        disabled={avoid ? false : count <= 0}
        style={{
          width: 34, height: 34, borderRadius: 10, border: `1px solid ${S.line}`,
          background: S.surface2, color: avoid || count > 0 ? S.muted : S.line, fontSize: 18, lineHeight: 1,
        }}
      >
        −
      </button>

      <button
        onClick={onInc}
        aria-label={avoid ? `Log a ${t.name} slip` : `Add one ${t.name}`}
        style={{
          minWidth: 84, height: 56, borderRadius: 12,
          border: `1px solid ${avoid ? "#F67E7E44" : `${t.color}44`}`,
          background: avoid ? "#F67E7E14" : `${t.color}1A`,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          animation: pulsing ? "tick .3s ease" : "none",
        }}
      >
        {avoid ? (
          <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 14, color: "#F67E7E", letterSpacing: 1 }}>
            I SLIPPED
          </span>
        ) : (
          <>
            <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: String(fmtNum(count)).length > 3 ? 20 : 30, color: t.color, fontVariantNumeric: "tabular-nums", letterSpacing: 1 }}>
              {fmtNum(count)}
            </span>
            {t.unit && (
              <span style={{ color: `${t.color}AA`, fontSize: 11, fontFamily: "'Rajdhani', sans-serif", fontWeight: 600, alignSelf: "flex-end", paddingBottom: 12 }}>{t.unit}</span>
            )}
            <span style={{ color: t.color, fontSize: 18, fontWeight: 600 }}>+</span>
          </>
        )}
      </button>
    </div>
  );
}

/* ============ DETAIL ============ */
function Detail({ tracker: t, events, notes, surprises, onSetNote, onBack, onEdit, onFocus, onDelete }) {
  const [confirmDel, setConfirmDel] = useState(false);
  const [noteDay, setNoteDay] = useState(null);
  const [noteDraft, setNoteDraft] = useState("");
  const avoid = t.mode === "avoid";

  const dayCounts = countsByDay(events, t.id);
  const total = events.filter((e) => e.trackerId === t.id).reduce((s, e) => s + e.delta, 0);
  const { days: streak, freezes } = calcStreak(dayCounts, t);
  const logCount = events.filter((e) => e.trackerId === t.id && e.delta > 0).length;
  const badgesStreak = MILESTONES_STREAK.filter((m) => streak >= m);
  const badgesLogs = avoid ? [] : MILESTONES_LOGS.filter((m) => logCount >= m);
  const nextLog = avoid ? null : MILESTONES_LOGS.find((m) => logCount < m);
  const nextStreak = MILESTONES_STREAK.find((m) => streak < m);
  const days7 = lastNDays(7);
  const max7 = Math.max(1, ...days7.map((d) => dayCounts[d] || 0));
  const days30 = lastNDays(30);
  const active30 = days30.filter((d) => (dayCounts[d] || 0) > 0).length;
  const recent = events.filter((e) => e.trackerId === t.id).slice(-12).reverse();
  const hours = hourHistogram(events, t.id);
  const peak = peakWindow(hours);
  const maxHour = Math.max(1, ...hours);
  const best = avoid ? bestCleanStreak(events, t) : null;

  /* heatmap: last 26 weeks, columns = weeks, rows = Sun..Sat */
  const heatDays = lastNDays(26 * 7);
  const offset = new Date(heatDays[0] + "T12:00").getDay(); // pad first column
  const heatMax = Math.max(1, ...heatDays.map((d) => dayCounts[d] || 0));

  const openNote = (d) => {
    setNoteDay(d === noteDay ? null : d);
    setNoteDraft(notes[d] || "");
  };

  return (
    <div style={{ animation: "fadeUp .25s ease" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: S.muted, fontSize: 14, padding: "4px 0", marginBottom: 12 }}>
        ‹ Back
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <span style={{ fontSize: 28 }}>{t.emoji}</span>
        <h2 style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 24, fontWeight: 700, letterSpacing: 1, margin: 0, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</h2>
        {!avoid && (
          <button onClick={() => onFocus(t)} style={{ background: `${t.color}1A`, border: `1px solid ${t.color}44`, borderRadius: 10, color: t.color, padding: "8px 12px", fontSize: 13, fontFamily: "'Rajdhani', sans-serif", fontWeight: 600, letterSpacing: 1 }}>
            ◎ FOCUS
          </button>
        )}
        <button onClick={() => onEdit(t)} style={{ background: S.surface, border: `1px solid ${S.line}`, borderRadius: 10, color: S.text, padding: "8px 14px", fontSize: 13 }}>
          Edit
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 20 }}>
        {avoid ? (
          <>
            <Stat label="CLEAN" value={`${streak}d`} color={t.color} />
            <Stat label="BEST" value={`${best}d`} color={t.color} />
            <Stat label="SLIPS" value={logCount} color={t.color} />
          </>
        ) : (
          <>
            <Stat label={t.unit ? `ALL-TIME ${t.unit.toUpperCase()}` : "ALL-TIME"} value={fmtNum(total)} color={t.color} />
            <Stat label="STREAK" value={`${streak}d${freezes > 0 ? " ❄️" : ""}`} color={t.color} />
            <Stat label="ACTIVE / 30D" value={active30} color={t.color} />
          </>
        )}
      </div>

      <div style={{ background: S.surface, border: `1px solid ${S.line}`, borderRadius: 14, padding: 16, marginBottom: 16 }}>
        <div style={{ fontFamily: "'Rajdhani', sans-serif", color: S.muted, fontSize: 13, letterSpacing: 2, marginBottom: 12 }}>MILESTONES</div>
        {badgesStreak.length + badgesLogs.length + surprises.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            {badgesStreak.map((m) => <Chip key={"s" + m} color={t.color} label={avoid ? `🛡️ ${m}D CLEAN` : `🔥 ${m}-DAY STREAK`} />)}
            {badgesLogs.map((m) => <Chip key={"l" + m} color={t.color} label={`🏆 ${m} LOGS`} />)}
            {surprises.map((sp) => <Chip key={sp.id} color={S.amber} label={sp.label} />)}
          </div>
        ) : (
          <div style={{ color: S.muted, fontSize: 13, marginBottom: 10 }}>No badges yet — keep logging.</div>
        )}
        <div style={{ color: S.muted, fontSize: 11 }}>
          Next up: {nextLog ? `${nextLog} logs · ` : ""}{nextStreak ? `${nextStreak}-day ${avoid ? "clean run" : "streak"}` : "—"}
        </div>
      </div>

      <div style={{ background: S.surface, border: `1px solid ${S.line}`, borderRadius: 14, padding: 16, marginBottom: 16 }}>
        <div style={{ fontFamily: "'Rajdhani', sans-serif", color: S.muted, fontSize: 13, letterSpacing: 2, marginBottom: 12 }}>
          LAST 7 DAYS <span style={{ letterSpacing: 0, textTransform: "none", fontFamily: "'Inter', sans-serif", fontSize: 11 }}>· tap a day to add a note</span>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 118 }}>
          {days7.map((d) => {
            const c = dayCounts[d] || 0;
            const h = Math.max(4, (c / max7) * 84);
            const hasNote = !!notes[d];
            return (
              <button key={d} onClick={() => openNote(d)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, background: "none", border: "none", padding: 0 }}>
                <div style={{ height: 8, fontSize: 8, color: S.amber }}>{hasNote ? "●" : ""}</div>
                <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 13, color: c ? t.color : S.line, fontWeight: 600 }}>{c ? fmtNum(c) : ""}</div>
                <div style={{ width: "100%", height: h, borderRadius: 5, background: c ? t.color : S.surface2, opacity: c ? 0.9 : 1, border: noteDay === d ? `1px solid ${S.text}` : "none" }} />
                <div style={{ fontSize: 10, color: S.muted }}>
                  {new Date(d + "T12:00").toLocaleDateString(undefined, { weekday: "narrow" })}
                </div>
              </button>
            );
          })}
        </div>
        {noteDay && (
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <input
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder={`Note for ${new Date(noteDay + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}…`}
              maxLength={80}
              style={{ flex: 1, minWidth: 0, padding: "10px 12px", borderRadius: 10, border: `1px solid ${S.line}`, background: S.surface2, color: S.text, fontSize: 13 }}
            />
            <button
              onClick={() => { onSetNote(noteDay, noteDraft); setNoteDay(null); }}
              style={{ background: t.color, border: "none", borderRadius: 10, color: "#14171C", padding: "0 16px", fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 13, letterSpacing: 1 }}
            >
              SAVE
            </button>
          </div>
        )}
      </div>

      <div style={{ background: S.surface, border: `1px solid ${S.line}`, borderRadius: 14, padding: 16, marginBottom: 16 }}>
        <div style={{ fontFamily: "'Rajdhani', sans-serif", color: S.muted, fontSize: 13, letterSpacing: 2, marginBottom: 12 }}>LAST 6 MONTHS</div>
        <div style={{ display: "flex", gap: 2, overflowX: "auto", paddingBottom: 4 }}>
          {Array.from({ length: 26 }, (_, w) => (
            <div key={w} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {Array.from({ length: 7 }, (_, r) => {
                const idx = w * 7 + r - offset;
                if (idx < 0 || idx >= heatDays.length) return <div key={r} style={{ width: 13, height: 13 }} />;
                const d = heatDays[idx];
                const c = dayCounts[d] || 0;
                const alpha = c === 0 ? 0 : 0.25 + 0.75 * (c / heatMax);
                return (
                  <div
                    key={r}
                    title={`${d}: ${fmtNum(c)}`}
                    style={{ width: 13, height: 13, borderRadius: 3, background: c === 0 ? S.surface2 : t.color, opacity: c === 0 ? 1 : alpha }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div style={{ background: S.surface, border: `1px solid ${S.line}`, borderRadius: 14, padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
          <div style={{ fontFamily: "'Rajdhani', sans-serif", color: S.muted, fontSize: 13, letterSpacing: 2 }}>{avoid ? "SLIP TIMES" : "TIME OF DAY"}</div>
          {peak && (
            <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 14, color: t.color, fontWeight: 600 }}>
              PEAK {fmtHour(peak.start)}–{fmtHour(peak.end)}
            </div>
          )}
        </div>
        {peak ? (
          <>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 70 }}>
              {hours.map((c, h) => {
                const inPeak = h === peak.start || h === (peak.start + 1) % 24;
                return (
                  <div
                    key={h}
                    title={`${fmtHour(h)}: ${c}`}
                    style={{
                      flex: 1,
                      height: Math.max(3, (c / maxHour) * 62),
                      borderRadius: 2,
                      background: c === 0 ? S.surface2 : inPeak ? t.color : `${t.color}66`,
                    }}
                  />
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 10, color: S.muted }}>
              <span>12AM</span><span>6AM</span><span>12PM</span><span>6PM</span><span>11PM</span>
            </div>
          </>
        ) : (
          <div style={{ color: S.muted, fontSize: 13 }}>Log a few entries and your peak hours will show up here.</div>
        )}
      </div>

      <div style={{ background: S.surface, border: `1px solid ${S.line}`, borderRadius: 14, padding: 16, marginBottom: 20 }}>
        <div style={{ fontFamily: "'Rajdhani', sans-serif", color: S.muted, fontSize: 13, letterSpacing: 2, marginBottom: 10 }}>RECENT LOG</div>
        {recent.length === 0 && <div style={{ color: S.muted, fontSize: 13 }}>No entries yet — tap + on the home screen to log one.</div>}
        {recent.map((e) => (
          <div key={e.id} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${S.line}`, fontSize: 13 }}>
            <span style={{ color: e.delta > 0 ? t.color : S.muted, fontFamily: "'Rajdhani', sans-serif", fontWeight: 600 }}>
              {e.delta > 0 ? (avoid ? "slip" : `+${fmtNum(e.delta)}${t.unit ? " " + t.unit : ""}`) : "−1"}
            </span>
            <span style={{ color: S.muted }}>
              {new Date(e.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </span>
          </div>
        ))}
      </div>

      {!confirmDel ? (
        <button onClick={() => setConfirmDel(true)} style={{ background: "none", border: "none", color: "#F67E7E", fontSize: 13, padding: 0 }}>
          Delete tracker
        </button>
      ) : (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: S.muted }}>Delete "{t.name}" and all its history?</span>
          <button onClick={() => onDelete(t.id)} style={{ background: "#F67E7E22", border: "1px solid #F67E7E55", color: "#F67E7E", borderRadius: 8, padding: "6px 12px", fontSize: 13 }}>
            Delete
          </button>
          <button onClick={() => setConfirmDel(false)} style={{ background: S.surface, border: `1px solid ${S.line}`, color: S.text, borderRadius: 8, padding: "6px 12px", fontSize: 13 }}>
            Keep
          </button>
        </div>
      )}
    </div>
  );
}

function Chip({ label, color }) {
  return (
    <span style={{ border: `1px solid ${color}55`, background: `${color}14`, color: S.text, borderRadius: 999, padding: "5px 12px", fontSize: 11, fontFamily: "'Rajdhani', sans-serif", fontWeight: 600, letterSpacing: 1 }}>
      {label}
    </span>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{ background: S.surface, border: `1px solid ${S.line}`, borderRadius: 14, padding: "12px 8px", textAlign: "center" }}>
      <div style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 24, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 11, color: S.muted, letterSpacing: 2, marginTop: 2 }}>{label}</div>
    </div>
  );
}

/* ============ FOCUS MODE ============ */
function FocusMode({ tracker: t, events, pulse, onTap, onUndo, onExit }) {
  const tk = todayKey();
  const count = events.filter((e) => e.trackerId === t.id && dayKey(e.ts) === tk).reduce((s, e) => s + e.delta, 0);
  return (
    <div
      onClick={() => onTap(t)}
      style={{
        position: "fixed", inset: 0, background: S.bg, zIndex: 40,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        userSelect: "none", cursor: "pointer",
      }}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onExit(); }}
        aria-label="Exit focus mode"
        style={{ position: "absolute", top: "calc(16px + env(safe-area-inset-top))", right: 20, background: S.surface, border: `1px solid ${S.line}`, borderRadius: 10, color: S.muted, fontSize: 16, width: 40, height: 40, zIndex: 41 }}
      >
        ✕
      </button>
      <div style={{ fontSize: 30, marginBottom: 4 }}>{t.emoji}</div>
      <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 18, color: S.muted, letterSpacing: 2, marginBottom: 18 }}>{t.name.toUpperCase()}</div>
      <div style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 120, lineHeight: 1, color: t.color, fontVariantNumeric: "tabular-nums", animation: pulse === t.id ? "tick .3s ease" : "none" }}>
        {fmtNum(count)}
      </div>
      {t.unit && <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 18, color: `${t.color}AA`, marginTop: 6 }}>{t.unit}</div>}
      <div style={{ color: S.muted, fontSize: 13, marginTop: 26, letterSpacing: 1 }}>tap anywhere to log</div>
      <button
        onClick={(e) => { e.stopPropagation(); onUndo(t.id); }}
        style={{ position: "absolute", bottom: "calc(30px + env(safe-area-inset-bottom))", background: S.surface, border: `1px solid ${S.line}`, borderRadius: 12, color: S.muted, fontSize: 14, padding: "10px 24px" }}
      >
        − undo
      </button>
    </div>
  );
}

/* ============ COMPARE ============ */
function Compare({ trackers, events, onBack }) {
  const [aId, setAId] = useState(trackers[0]?.id);
  const [bId, setBId] = useState(trackers[1]?.id);
  const a = trackers.find((t) => t.id === aId);
  const b = trackers.find((t) => t.id === bId);
  const days = lastNDays(14);
  const aCounts = a ? countsByDay(events, a.id) : {};
  const bCounts = b ? countsByDay(events, b.id) : {};
  const aMax = Math.max(1, ...days.map((d) => aCounts[d] || 0));
  const bMax = Math.max(1, ...days.map((d) => bCounts[d] || 0));

  const sel = {
    flex: 1, minWidth: 0, padding: "11px 12px", borderRadius: 12, border: `1px solid ${S.line}`,
    background: S.surface, color: S.text, fontSize: 14,
  };

  return (
    <div style={{ animation: "fadeUp .25s ease" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: S.muted, fontSize: 14, padding: "4px 0", marginBottom: 12 }}>
        ‹ Back
      </button>
      <h2 style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 24, fontWeight: 700, letterSpacing: 1, marginTop: 0, marginBottom: 16 }}>COMPARE</h2>

      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <select value={aId} onChange={(e) => setAId(e.target.value)} style={sel}>
          {trackers.map((t) => <option key={t.id} value={t.id}>{t.emoji} {t.name}</option>)}
        </select>
        <select value={bId} onChange={(e) => setBId(e.target.value)} style={sel}>
          {trackers.map((t) => <option key={t.id} value={t.id}>{t.emoji} {t.name}</option>)}
        </select>
      </div>

      {a && b && (
        <div style={{ background: S.surface, border: `1px solid ${S.line}`, borderRadius: 14, padding: 16 }}>
          <div style={{ display: "flex", gap: 14, marginBottom: 14, fontSize: 12 }}>
            <span style={{ color: a.color }}>■ {a.name}</span>
            <span style={{ color: b.color }}>■ {b.name}</span>
          </div>
          <div style={{ fontFamily: "'Rajdhani', sans-serif", color: S.muted, fontSize: 12, letterSpacing: 2, marginBottom: 10 }}>LAST 14 DAYS · each scaled to its own max</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120 }}>
            {days.map((d) => {
              const ca = aCounts[d] || 0;
              const cb = bCounts[d] || 0;
              return (
                <div key={d} style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: 2, height: "100%" }}>
                  <div title={`${a.name}: ${fmtNum(ca)}`} style={{ flex: 1, height: Math.max(3, (ca / aMax) * 110), borderRadius: 3, background: ca ? a.color : S.surface2, opacity: ca ? 0.9 : 1 }} />
                  <div title={`${b.name}: ${fmtNum(cb)}`} style={{ flex: 1, height: Math.max(3, (cb / bMax) * 110), borderRadius: 3, background: cb ? b.color : S.surface2, opacity: cb ? 0.9 : 1 }} />
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 10, color: S.muted }}>
            <span>{new Date(days[0] + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
            <span>today</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============ AMOUNT MODAL ============ */
function AmountModal({ t, onSubmit, onClose }) {
  const [val, setVal] = useState("");
  const num = parseFloat(val);
  const ok = !isNaN(num) && num > 0;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "#000000AA", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: S.surface, border: `1px solid ${S.line}`, borderRadius: 16, padding: 20, width: "85%", maxWidth: 340 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>{t.emoji} {t.name}</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16 }}>
          <input
            autoFocus
            value={val}
            onChange={(e) => setVal(e.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            placeholder="0"
            style={{ flex: 1, minWidth: 0, padding: "13px 14px", borderRadius: 12, border: `1px solid ${S.line}`, background: S.surface2, color: S.text, fontSize: 22, fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}
          />
          <span style={{ color: S.muted, fontFamily: "'Rajdhani', sans-serif", fontSize: 16, fontWeight: 600 }}>{t.unit}</span>
        </div>
        <button
          disabled={!ok}
          onClick={() => ok && onSubmit(num)}
          style={{ width: "100%", padding: 13, borderRadius: 12, border: "none", background: ok ? t.color : S.surface2, color: ok ? "#14171C" : S.muted, fontFamily: "'Rajdhani', sans-serif", fontSize: 16, fontWeight: 700, letterSpacing: 1 }}
        >
          LOG IT
        </button>
      </div>
    </div>
  );
}

/* ============ FORM ============ */
function TrackerForm({ tracker, onSave, onCancel }) {
  const [name, setName] = useState(tracker?.name || "");
  const [emoji, setEmoji] = useState(tracker?.emoji || "🔥");
  const [color, setColor] = useState(tracker?.color || COLORS[0]);
  const [goal, setGoal] = useState(tracker?.goal || "");
  const [unit, setUnit] = useState(tracker?.unit || "");
  const [mode, setMode] = useState(tracker?.mode || "count");

  const submit = () => {
    if (!name.trim()) return;
    onSave({
      ...(tracker || {}),
      name: name.trim(),
      emoji,
      color,
      mode,
      goal: mode === "count" && goal ? Number(goal) : null,
      unit: mode === "count" ? unit.trim() || null : null,
    });
  };

  const label = { fontFamily: "'Rajdhani', sans-serif", fontSize: 13, color: S.muted, letterSpacing: 2, display: "block", marginBottom: 8 };
  const modeBtn = (m, title, desc) => (
    <button
      onClick={() => setMode(m)}
      style={{
        flex: 1, padding: "12px 10px", borderRadius: 12, textAlign: "left",
        border: `1px solid ${mode === m ? S.amber : S.line}`,
        background: mode === m ? `${S.amber}14` : S.surface, color: S.text,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>{title}</div>
      <div style={{ color: S.muted, fontSize: 11, lineHeight: 1.4 }}>{desc}</div>
    </button>
  );

  return (
    <div style={{ animation: "fadeUp .25s ease" }}>
      <button onClick={onCancel} style={{ background: "none", border: "none", color: S.muted, fontSize: 14, padding: "4px 0", marginBottom: 12 }}>
        ‹ Cancel
      </button>
      <h2 style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 24, fontWeight: 700, letterSpacing: 1, marginTop: 0, marginBottom: 20 }}>
        {tracker ? "EDIT TRACKER" : "NEW TRACKER"}
      </h2>

      <label style={label}>TYPE</label>
      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        {modeBtn("count", "📈 Build", "Count things you do — streak grows when you log")}
        {modeBtn("avoid", "🛡️ Avoid", "Quit things — streak grows on days you DON'T log")}
      </div>

      <label style={label}>NAME</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={mode === "avoid" ? "e.g. Cigarettes, Energy drinks, Impulse buys" : "e.g. Coffees, Workouts, Sales calls"}
        style={{
          width: "100%", padding: "13px 14px", borderRadius: 12, border: `1px solid ${S.line}`,
          background: S.surface, color: S.text, fontSize: 15, marginBottom: 20,
        }}
      />

      {mode === "count" && (
        <>
          <label style={label}>UNIT (OPTIONAL)</label>
          <input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="oz, cal, $, miles — blank = simple counting"
            maxLength={8}
            style={{
              width: "100%", padding: "13px 14px", borderRadius: 12, border: `1px solid ${S.line}`,
              background: S.surface, color: S.text, fontSize: 15, marginBottom: 8,
            }}
          />
          <div style={{ color: S.muted, fontSize: 12, marginBottom: 20 }}>
            With a unit set, tapping + asks for an amount (e.g. 650 cal) instead of adding 1.
          </div>
        </>
      )}

      <label style={label}>ICON</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
        {EMOJIS.map((e) => (
          <button
            key={e}
            onClick={() => setEmoji(e)}
            aria-label={`Icon ${e}`}
            style={{
              width: 42, height: 42, borderRadius: 10, fontSize: 20,
              border: `1px solid ${emoji === e ? S.amber : S.line}`,
              background: emoji === e ? `${S.amber}1A` : S.surface,
            }}
          >
            {e}
          </button>
        ))}
      </div>

      <label style={label}>COLOR</label>
      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            aria-label={`Color ${c}`}
            style={{
              width: 34, height: 34, borderRadius: "50%", background: c,
              border: color === c ? `3px solid ${S.text}` : `3px solid transparent`,
            }}
          />
        ))}
      </div>

      {mode === "count" && (
        <>
          <label style={label}>DAILY GOAL (OPTIONAL)</label>
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value.replace(/\D/g, ""))}
            placeholder="e.g. 8"
            inputMode="numeric"
            style={{
              width: "100%", padding: "13px 14px", borderRadius: 12, border: `1px solid ${S.line}`,
              background: S.surface, color: S.text, fontSize: 15, marginBottom: 28,
            }}
          />
        </>
      )}

      <button
        onClick={submit}
        disabled={!name.trim()}
        style={{
          width: "100%", padding: 15, borderRadius: 14, border: "none", marginTop: mode === "avoid" ? 8 : 0,
          background: name.trim() ? S.amber : S.surface2, color: name.trim() ? "#14171C" : S.muted,
          fontFamily: "'Rajdhani', sans-serif", fontSize: 17, fontWeight: 700, letterSpacing: 2,
        }}
      >
        {tracker ? "SAVE CHANGES" : "CREATE TRACKER"}
      </button>
    </div>
  );
}
