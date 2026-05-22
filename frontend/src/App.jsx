import { useState, useEffect, useCallback, useRef } from "react";
import FloorPlan from "./FloorPlan";
import PcPanel from "./PcPanel";
import Editor from "./Editor";
import "./App.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";
const REFRESH_INTERVAL = 5000;

export default function App() {
  const [pcs, setPcs] = useState([]);
  const [positions, setPositions] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedPc, setSelectedPc] = useState(null);
  const [wolStatus, setWolStatus] = useState({});
  const [lastUpdate, setLastUpdate] = useState(null);
  const [error, setError] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const fetchingRef = useRef(false);

  // Carica posizioni una volta sola all'avvio
  useEffect(() => {
    fetch(`${API}/api/positions`)
      .then((r) => r.json())
      .then(setPositions)
      .catch(() => {});
  }, []);

  const fetchPcs = useCallback(async (isManual = false) => {
    if (fetchingRef.current && !isManual) return;
    fetchingRef.current = true;
    if (isManual) setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/pcs`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPcs(data);
      setLastUpdate(new Date());
    } catch (e) {
      setError("Impossibile connettersi al backend. Assicurati che Flask sia in esecuzione.");
    } finally {
      setLoading(false);
      setRefreshing(false);
      fetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchPcs();
    const interval = setInterval(() => fetchPcs(), REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchPcs]);

  const handleWol = async (hostname) => {
    setWolStatus((s) => ({ ...s, [hostname]: "sending" }));
    try {
      const res = await fetch(`${API}/api/wol/${hostname}`, { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setWolStatus((s) => ({ ...s, [hostname]: "sent" }));
        setTimeout(() => setWolStatus((s) => ({ ...s, [hostname]: null })), 5000);
      } else {
        setWolStatus((s) => ({ ...s, [hostname]: "error" }));
      }
    } catch {
      setWolStatus((s) => ({ ...s, [hostname]: "error" }));
    }
  };

  const handleShutdown = async (hostname) => {
    try {
      const res = await fetch(`${API}/api/shutdown/${hostname}`, { method: "POST" });
      const data = await res.json();
      return data.ok ? "ok" : "error";
    } catch {
      return "error";
    }
  };

  const handleSavePositions = (newPositions) => {
    setPositions(newPositions);
    setEditorOpen(false);
  };

  const stats = {
    online: pcs.filter((p) => p.online).length,
    offline: pcs.filter((p) => !p.online && p.ip).length,
    unknown: pcs.filter((p) => !p.ip).length,
    total: pcs.length,
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1 className="title">Ciro Marina — Sede</h1>
          {lastUpdate && (
            <span className="last-update">
              Aggiornato alle {lastUpdate.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
        </div>
        <div className="header-right">
          <div className="stats">
            <span className="stat online">{stats.online} online</span>
            <span className="stat offline">{stats.offline} offline</span>
            {stats.unknown > 0 && <span className="stat unknown">{stats.unknown} N/D</span>}
          </div>
          <button
            className="btn-refresh"
            onClick={() => setEditorOpen(true)}
          >
            Modifica posizioni
          </button>
          <button
            className={`btn-refresh ${refreshing ? "spinning" : ""}`}
            onClick={() => fetchPcs(true)}
            disabled={refreshing}
          >
            ↻ Aggiorna
          </button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <main className="main">
        {loading ? (
          <div className="loading">Caricamento postazioni...</div>
        ) : (
          <FloorPlan
            pcs={pcs}
            positions={positions}
            selectedHostname={selectedPc?.hostname}
            onSelect={setSelectedPc}
            wolStatus={wolStatus}
            onOpenEditor={() => setEditorOpen(true)}
          />
        )}
      </main>

      {selectedPc && (
        <PcPanel
          pc={pcs.find((p) => p.hostname === selectedPc.hostname) || selectedPc}
          wolStatus={wolStatus[selectedPc.hostname]}
          onWol={handleWol}
          onShutdown={handleShutdown}
          onClose={() => setSelectedPc(null)}
        />
      )}

      {editorOpen && (
        <Editor
          pcs={pcs.length > 0 ? pcs : Object.keys(positions).map((h) => ({ hostname: h }))}
          initialPositions={positions}
          onSave={handleSavePositions}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
}
