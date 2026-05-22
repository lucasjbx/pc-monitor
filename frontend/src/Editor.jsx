import { useState, useRef } from "react";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

export default function Editor({ pcs, initialPositions, onSave, onClose }) {
  const [positions, setPositions] = useState({ ...initialPositions });
  const [selected, setSelected] = useState(null);
  const [saving, setSaving] = useState(false);
  const imgRef = useRef(null);

  const handleImageClick = (e) => {
    if (!selected) return;
    const rect = imgRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const next_positions = { ...positions, [selected]: { x, y } };
    setPositions(next_positions);
    // Avanza automaticamente al prossimo PC non posizionato
    const next = pcs.find((p) => !next_positions[p.hostname] && p.hostname !== selected);
    setSelected(next?.hostname || null);
  };

  const removePosition = (hostname, e) => {
    e.stopPropagation();
    const { [hostname]: _, ...rest } = positions;
    setPositions(rest);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch(`${API}/api/positions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(positions),
      });
      onSave(positions);
    } finally {
      setSaving(false);
    }
  };

  const allHostnames = pcs.map((p) => p.hostname);
  const placed = allHostnames.filter((h) => positions[h]);
  const unplaced = allHostnames.filter((h) => !positions[h]);

  return (
    <div className="editor-overlay">
      <div className="editor-container">

        {/* Mappa */}
        <div className="editor-map">
          <div className={`editor-instruction ${selected ? "active" : ""}`}>
            {selected
              ? `Clicca sulla mappa per posizionare ${selected}`
              : "Seleziona un PC dalla lista →"}
          </div>
          <div className="editor-image-wrapper">
            <img
              ref={imgRef}
              src={`${API}/api/floorplan`}
              className={`editor-image ${selected ? "crosshair" : ""}`}
              alt="Piantina"
              onClick={handleImageClick}
              draggable={false}
            />
            {placed.map((hostname) => {
              const pos = positions[hostname];
              return (
                <div
                  key={hostname}
                  className={`editor-marker${selected === hostname ? " active" : ""}`}
                  style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%` }}
                  onClick={(e) => { e.stopPropagation(); setSelected(hostname); }}
                  title={hostname}
                >
                  {hostname}
                </div>
              );
            })}
          </div>
        </div>

        {/* Sidebar */}
        <div className="editor-sidebar">
          <div className="editor-sidebar-header">
            <h2>Posizioni PC</h2>
            <button className="panel-close" onClick={onClose}>✕</button>
          </div>

          {unplaced.length > 0 && (
            <div className="editor-section">
              <div className="editor-section-title">
                Da posizionare <span className="editor-count">{unplaced.length}</span>
              </div>
              {unplaced.map((h) => (
                <div
                  key={h}
                  className={`editor-pc-item${selected === h ? " active" : ""}`}
                  onClick={() => setSelected(h)}
                >
                  {h}
                </div>
              ))}
            </div>
          )}

          {placed.length > 0 && (
            <div className="editor-section">
              <div className="editor-section-title">
                Posizionati <span className="editor-count ok">{placed.length}</span>
              </div>
              {placed.map((h) => (
                <div
                  key={h}
                  className={`editor-pc-item placed${selected === h ? " active" : ""}`}
                  onClick={() => setSelected(h)}
                >
                  <span>{h}</span>
                  <button
                    className="editor-remove"
                    onClick={(e) => removePosition(h, e)}
                    title="Rimuovi posizione"
                  >×</button>
                </div>
              ))}
            </div>
          )}

          <div className="editor-footer">
            <button className="btn-save" onClick={handleSave} disabled={saving}>
              {saving ? "Salvataggio…" : `Salva (${placed.length} PC)`}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
