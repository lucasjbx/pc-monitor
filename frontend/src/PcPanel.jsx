/**
 * PcPanel — Pannello laterale con dettagli PC, WOL e spegnimento
 */
import { useState } from "react";

export default function PcPanel({ pc, wolStatus, onWol, onShutdown, onClose }) {
  const [shutdownState, setShutdownState] = useState(null);
  // null | "confirm" | "sending" | "ok" | "error"

  if (!pc) return null;

  const canWol = !pc.online && pc.mac;
  const canShutdown = pc.online && pc.ip;

  const handleShutdownClick = () => {
    if (shutdownState === "confirm") {
      setShutdownState("sending");
      onShutdown(pc.hostname).then((result) => {
        setShutdownState(result === "ok" ? "ok" : "error");
        if (result === "ok") {
          setTimeout(() => setShutdownState(null), 5000);
        }
      });
    } else {
      setShutdownState("confirm");
    }
  };

  const cancelShutdown = () => setShutdownState(null);

  return (
    <div className="pc-panel">
      <button className="panel-close" onClick={onClose} aria-label="Chiudi">✕</button>

      <div className="panel-header">
        <div className={`panel-status-dot ${pc.online ? "online" : pc.ip ? "offline" : "unknown"}`} />
        <h2 className="panel-hostname">{pc.hostname}</h2>
      </div>

      <div className="panel-badge-row">
        <span className={`panel-badge ${pc.online ? "badge-online" : pc.ip ? "badge-offline" : "badge-unknown"}`}>
          {pc.online ? "Online" : pc.ip ? "Offline" : "N/D"}
        </span>
        {pc.manufacturer && (
          <span className="panel-badge badge-neutral">{pc.manufacturer}</span>
        )}
      </div>

      <table className="panel-table">
        <tbody>
          <tr>
            <td className="panel-label">IP</td>
            <td className="panel-value">{pc.ip || "—"}</td>
          </tr>
          <tr>
            <td className="panel-label">MAC</td>
            <td className="panel-value panel-mono">{pc.mac || "—"}</td>
          </tr>
          <tr>
            <td className="panel-label">Utente</td>
            <td className="panel-value">
              {pc.user
                ? <strong>{pc.user}</strong>
                : pc.online
                  ? <span className="muted">Nessun utente loggato</span>
                  : <span className="muted">—</span>
              }
            </td>
          </tr>
        </tbody>
      </table>

      {/* Wake on LAN */}
      {canWol && (
        <div className="wol-section">
          <button
            className={`btn-wol ${wolStatus === "sending" ? "sending" : ""} ${wolStatus === "sent" ? "sent" : ""}`}
            onClick={() => onWol(pc.hostname)}
            disabled={wolStatus === "sending"}
          >
            {wolStatus === "sending" && "⟳ Invio in corso…"}
            {wolStatus === "sent"    && "✓ Pacchetto inviato"}
            {wolStatus === "error"   && "✕ Errore — riprova"}
            {!wolStatus && "⚡ Accendi (Wake on LAN)"}
          </button>
          {wolStatus === "sent" && (
            <p className="wol-note">Il PC dovrebbe avviarsi entro 30–60 secondi.</p>
          )}
        </div>
      )}

      {/* Spegnimento */}
      {canShutdown && (
        <div className="shutdown-section">
          {shutdownState === "confirm" ? (
            <div className="shutdown-confirm">
              <p className="shutdown-warning">
                Spegnere <strong>{pc.hostname}</strong>?
                {pc.user && <> L'utente <strong>{pc.user}</strong> potrebbe perdere il lavoro non salvato.</>}
              </p>
              <div className="shutdown-confirm-buttons">
                <button className="btn-shutdown-confirm" onClick={handleShutdownClick}>
                  Sì, spegni
                </button>
                <button className="btn-shutdown-cancel" onClick={cancelShutdown}>
                  Annulla
                </button>
              </div>
            </div>
          ) : (
            <button
              className={`btn-shutdown ${shutdownState === "sending" ? "sending" : ""} ${shutdownState === "ok" ? "ok" : ""} ${shutdownState === "error" ? "error" : ""}`}
              onClick={handleShutdownClick}
              disabled={shutdownState === "sending"}
            >
              {shutdownState === "sending" && "⟳ Spegnimento…"}
              {shutdownState === "ok"      && "✓ Comando inviato"}
              {shutdownState === "error"   && "✕ Errore — riprova"}
              {!shutdownState && "⏻ Spegni PC"}
            </button>
          )}
        </div>
      )}

      {!canWol && !pc.online && !pc.ip && (
        <p className="panel-note">MAC address non disponibile — WOL non supportato.</p>
      )}
    </div>
  );
}
