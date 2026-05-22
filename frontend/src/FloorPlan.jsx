const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

function markerColor(pc) {
  if (!pc.ip) return "unknown";
  return pc.online ? "online" : "offline";
}

export default function FloorPlan({ pcs, positions, selectedHostname, onSelect, wolStatus, onOpenEditor }) {
  const pcMap = Object.fromEntries(pcs.map((p) => [p.hostname, p]));
  const placed = Object.keys(positions);

  if (placed.length === 0) {
    return (
      <div className="floorplan-empty">
        <p>Nessuna posizione configurata.</p>
        <button className="btn-refresh" onClick={onOpenEditor}>
          Configura posizioni
        </button>
      </div>
    );
  }

  return (
    <div className="floorplan-wrapper">
      <div className="floorplan-image-container">
        <img
          src={`${API}/api/floorplan`}
          className="floorplan-image"
          alt="Piantina sede"
          draggable={false}
        />
        {placed.map((hostname) => {
          const pos = positions[hostname];
          const pc = pcMap[hostname] || { hostname, ip: "", mac: "", online: false, user: "" };
          const cls = markerColor(pc);
          const isSelected = hostname === selectedHostname;

          return (
            <div
              key={hostname}
              className={`pc-marker ${cls}${isSelected ? " selected" : ""}`}
              style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%` }}
              onClick={() => onSelect(pc)}
            >
              <div className="marker-dot" />
              <div className="marker-label">
                <span className="marker-hostname">{hostname}</span>
                {pc.user && (
                  <span className="marker-user">
                    {pc.user.length > 11 ? pc.user.slice(0, 11) + "…" : pc.user}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="legend">
        <span className="legend-item">
          <span className="legend-dot" style={{ background: "#2a7d46" }} />Online
        </span>
        <span className="legend-item">
          <span className="legend-dot" style={{ background: "#8a3030" }} />Offline
        </span>
        <span className="legend-item">
          <span className="legend-dot" style={{ background: "#888780" }} />N/D
        </span>
      </div>
    </div>
  );
}
